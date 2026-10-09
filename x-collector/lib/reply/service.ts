import { z } from "zod";
import { q, q1, tx } from "../trade/pg";
import {
  Account,
  Campaign,
  AccountInput,
  Filters,
  Settings,
  validTimezone,
  LoreInput,
  SourceInput,
  ExampleInput,
} from "./model";
import { seal, unseal, proxyFingerprint } from "./secrets";
import {
  parseProxy,
  proxyIdentity,
  testProxy,
  proxyGeolocation,
  ProxyConfig,
} from "./proxy";
import { XClient, Credentials, XError } from "./x-api";
import { embed, validateReply } from "./llm";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const idParam = (value: string) => {
  if (!/^\d{1,18}$/.test(value)) throw new ApiError(400, "invalid ID");
  return value;
};
export async function accountFor(user: string, id: string): Promise<Account> {
  const row = await q1<Account>(
    "SELECT * FROM reply_accounts WHERE id=$1 AND user_id=$2",
    [idParam(id), user],
  );
  if (!row) throw new ApiError(404, "account not found");
  return row;
}
export async function campaignFor(user: string, id: string): Promise<Campaign> {
  const row = await q1<Campaign>(
    "SELECT * FROM reply_campaigns WHERE id=$1 AND user_id=$2",
    [idParam(id), user],
  );
  if (!row) throw new ApiError(404, "campaign not found");
  return row;
}
export async function alert(
  user: string,
  account: string | null,
  type: string,
  message: string,
): Promise<void> {
  await q(
    "INSERT INTO reply_alerts(user_id,account_id,type,message) SELECT $1,$2,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM reply_alerts WHERE user_id=$1 AND account_id IS NOT DISTINCT FROM $2::bigint AND type=$3 AND created_at>now()-interval '10 minutes')",
    [user, account, type, message],
  );
}
export const publicAccounts = (user: string) =>
  q(
    "SELECT id,x_user_id,x_username,status,proxy_status,proxy_latency_ms,proxy_country,timezone,browser_profile,last_health_at,cooldown_until,created_at FROM reply_accounts WHERE user_id=$1 ORDER BY id",
    [user],
  );
export async function addAccount(user: string, raw: unknown) {
  const input = AccountInput.parse(raw);
  if (!validTimezone(input.timezone))
    throw new ApiError(400, "invalid timezone");
  const proxy = input.proxy_string ? parseProxy(input.proxy_string) : undefined;
  let geo: { country: string; timezone: string } | null = null;
  let proxyStatus = proxy ? "dead" : "none";
  let latency: number | null = null;
  let status = "needs_auth";
  let identity: { id: string; username: string } | undefined;
  if (proxy) {
    try {
      const checked = await testProxy(proxy);
      proxyStatus = "ready";
      latency = checked.latency_ms;
      geo = await proxyGeolocation(checked.ip);
    } catch {
      /* stored paused, never fall back to direct IP */
    }
  }
  if (!proxy || proxyStatus === "ready") {
    try {
      identity = await new XClient(input, proxy).me();
      status = "ready";
    } catch (error) {
      status =
        error instanceof XError && error.status === 403
          ? "blocked"
          : "needs_auth";
    }
  }
  if (proxyStatus === "dead") status = "paused";
  const row = await q1<{ id: string }>(
    "INSERT INTO reply_accounts(user_id,x_user_id,x_username,credentials_encrypted,proxy_encrypted,proxy_fingerprint,proxy_status,proxy_latency_ms,timezone,status,proxy_country,last_health_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()) RETURNING id",
    [
      user,
      identity?.id ?? null,
      identity?.username ?? null,
      seal({
        access_token: input.access_token,
        refresh_token: input.refresh_token,
      }),
      proxy ? seal(proxy) : null,
      proxy ? proxyFingerprint(proxyIdentity(proxy)) : null,
      proxyStatus,
      latency,
      geo?.timezone ?? input.timezone,
      status,
      geo?.country ?? null,
    ],
  );
  if (!row) throw new Error("account insert failed");
  if (status !== "ready")
    await alert(
      user,
      row.id,
      status,
      "Account verification requires attention; check credentials or proxy",
    );
  return (await publicAccounts(user)).find(
    (a) => String(a.id) === String(row.id),
  );
}
export async function updateAccount(user: string, id: string, raw: unknown) {
  const account = await accountFor(user, id);
  const input = AccountInput.partial()
    .extend({ status: z.enum(["paused", "ready"]).optional() })
    .strict()
    .parse(raw);
  if (input.timezone && !validTimezone(input.timezone))
    throw new ApiError(400, "invalid timezone");
  if (input.proxy_string !== undefined)
    throw new ApiError(400, "use account proxy endpoint");
  const credentials = unseal<Credentials>(account.credentials_encrypted);
  if (input.access_token) credentials.access_token = input.access_token;
  if (input.refresh_token !== undefined)
    credentials.refresh_token = input.refresh_token;
  let status = input.status ?? account.status;
  let identity: { id: string; username: string } | undefined;
  if (input.access_token || status === "ready") {
    if (account.proxy_status === "dead")
      throw new ApiError(409, "replace dead proxy first");
    identity = await new XClient(
      credentials,
      account.proxy_encrypted
        ? unseal<ProxyConfig>(account.proxy_encrypted)
        : undefined,
    ).me();
    if (account.x_user_id && identity.id !== account.x_user_id)
      throw new ApiError(409, "credentials belong to another X account");
    status = "ready";
  }
  await tx(async (c) => {
    await c.query(
      "UPDATE reply_accounts SET credentials_encrypted=$1,status=$2,timezone=$3,x_user_id=COALESCE($4,x_user_id),x_username=COALESCE($5,x_username) WHERE id=$6 AND user_id=$7",
      [
        seal(credentials),
        status,
        input.timezone ?? account.timezone,
        identity?.id ?? null,
        identity?.username ?? null,
        id,
        user,
      ],
    );
    if (status !== "ready")
      await c.query(
        "UPDATE reply_campaigns SET status='stopped' WHERE account_id=$1",
        [id],
      );
  });
  return (await publicAccounts(user)).find((a) => String(a.id) === String(id));
}
export async function setProxy(user: string, id: string, raw: unknown) {
  await accountFor(user, id);
  const input = z
    .object({ proxy_string: z.string().min(1).max(2000) })
    .strict()
    .parse(raw);
  const proxy = parseProxy(input.proxy_string);
  let geo: { country: string; timezone: string } | null = null;
  let status = "dead",
    latency: number | null = null;
  try {
    const checked = await testProxy(proxy);
    latency = checked.latency_ms;
    status = "ready";
    geo = await proxyGeolocation(checked.ip);
  } catch {
    /* never direct fallback */
  }
  await tx(async (c) => {
    await c.query(
      "UPDATE reply_accounts SET proxy_encrypted=$1,proxy_fingerprint=$2,proxy_status=$3,proxy_latency_ms=$4,status='paused',proxy_country=$7,timezone=COALESCE($8,timezone) WHERE id=$5 AND user_id=$6",
      [
        seal(proxy),
        proxyFingerprint(proxyIdentity(proxy)),
        status,
        latency,
        id,
        user,
        geo?.country ?? null,
        geo?.timezone ?? null,
      ],
    );
    await c.query(
      "UPDATE reply_campaigns SET status='stopped' WHERE account_id=$1",
      [id],
    );
  });
  if (status === "dead")
    await alert(user, id, "proxy_dead", "Proxy unavailable; account paused");
  return { status, latency_ms: latency };
}
export async function createCampaign(user: string, raw: unknown) {
  const input = z
    .object({
      account_id: z.coerce.string().regex(/^\d+$/),
      lore_id: z.coerce.string().regex(/^\d+$/),
      settings: Settings.default({}),
      filters: Filters.default({}),
    })
    .strict()
    .parse(raw);
  await accountFor(user, input.account_id);
  if (
    !(await q1("SELECT id FROM reply_lore WHERE id=$1 AND user_id=$2", [
      input.lore_id,
      user,
    ]))
  )
    throw new ApiError(404, "lore not found");
  return q1(
    "INSERT INTO reply_campaigns(user_id,account_id,lore_id,settings_json,filters_json) VALUES($1,$2,$3,$4::jsonb,$5::jsonb) RETURNING *",
    [
      user,
      input.account_id,
      input.lore_id,
      JSON.stringify(input.settings),
      JSON.stringify(input.filters),
    ],
  );
}
export async function patchCampaign(user: string, id: string, raw: unknown) {
  const campaign = await campaignFor(user, id);
  const input = z
    .object({
      lore_id: z.coerce.string().regex(/^\d+$/).optional(),
      settings: Settings.partial().optional(),
    })
    .strict()
    .parse(raw);
  if (
    input.lore_id &&
    !(await q1("SELECT id FROM reply_lore WHERE id=$1 AND user_id=$2", [
      input.lore_id,
      user,
    ]))
  )
    throw new ApiError(404, "lore not found");
  return q1(
    "UPDATE reply_campaigns SET lore_id=$1,settings_json=$2::jsonb WHERE id=$3 AND user_id=$4 RETURNING *",
    [
      input.lore_id ?? campaign.lore_id,
      JSON.stringify(
        Settings.parse({ ...campaign.settings_json, ...input.settings }),
      ),
      id,
      user,
    ],
  );
}
export async function startCampaign(user: string, id: string) {
  const campaign = await campaignFor(user, id);
  const account = await accountFor(user, campaign.account_id);
  if (account.status !== "ready" || account.proxy_status === "dead")
    throw new ApiError(409, "account is not ready");
  const lore = await q1<{ country: string }>(
    "SELECT country FROM reply_lore WHERE id=$1 AND user_id=$2",
    [campaign.lore_id, user],
  );
  if (
    lore?.country &&
    account.proxy_encrypted &&
    lore.country !== account.proxy_country
  )
    throw new ApiError(
      409,
      "proxy country is unverified or differs from persona country",
    );
  if (!(await q1("SELECT id FROM reply_sources WHERE campaign_id=$1", [id])))
    throw new ApiError(409, "add a source first");
  const examples = await q1<{ n: number }>(
    "SELECT COUNT(*)::int n FROM reply_examples WHERE lore_id=$1",
    [campaign.lore_id],
  );
  if (!examples || examples.n < 3)
    throw new ApiError(409, "add at least three embedded lore examples first");
  await q(
    "UPDATE reply_campaigns SET status='running' WHERE id=$1 AND user_id=$2",
    [id, user],
  );
  return { status: "running" };
}
export async function addLore(user: string, raw: unknown) {
  const input = LoreInput.parse(raw);
  return q1(
    "INSERT INTO reply_lore(user_id,name,style,bio,system_prompt,country) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
    [
      user,
      input.name,
      input.style,
      input.bio,
      input.system_prompt,
      input.country,
    ],
  );
}
export async function patchLore(user: string, id: string, raw: unknown) {
  const old = await q1("SELECT * FROM reply_lore WHERE id=$1 AND user_id=$2", [
    idParam(id),
    user,
  ]);
  if (!old) throw new ApiError(404, "lore not found");
  const input = LoreInput.parse({
    name: old.name,
    style: old.style,
    bio: old.bio,
    system_prompt: old.system_prompt,
    country: old.country,
    ...LoreInput.partial().parse(raw),
  });
  return q1(
    "UPDATE reply_lore SET name=$1,style=$2,bio=$3,system_prompt=$4,country=$7 WHERE id=$5 AND user_id=$6 RETURNING *",
    [
      input.name,
      input.style,
      input.bio,
      input.system_prompt,
      id,
      user,
      input.country,
    ],
  );
}
export async function addExample(user: string, id: string, raw: unknown) {
  if (
    !(await q1("SELECT id FROM reply_lore WHERE id=$1 AND user_id=$2", [
      idParam(id),
      user,
    ]))
  )
    throw new ApiError(404, "lore not found");
  const input = ExampleInput.parse(raw);
  const vector = await embed(input.tweet_text);
  return tx(async (c) => {
    await c.query("SELECT id FROM reply_lore WHERE id=$1 FOR UPDATE", [id]);
    const count = await c.query<{ n: number }>(
      "SELECT COUNT(*)::int n FROM reply_examples WHERE lore_id=$1",
      [id],
    );
    if (count.rows[0].n >= 15) throw new ApiError(409, "maximum 15 examples");
    return (
      await c.query(
        "INSERT INTO reply_examples(lore_id,tweet_text,reply_text,embedding,embedding_model) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING id,lore_id,tweet_text,reply_text,embedding_model",
        [
          id,
          input.tweet_text,
          input.reply_text,
          JSON.stringify(vector.vector),
          vector.model,
        ],
      )
    ).rows[0];
  });
}
export async function addSource(user: string, id: string, raw: unknown) {
  await campaignFor(user, id);
  const input = SourceInput.parse(raw);
  return tx(async (c) => {
    await c.query("SELECT id FROM reply_campaigns WHERE id=$1 FOR UPDATE", [
      id,
    ]);
    const count = await c.query<{ n: number }>(
      "SELECT COUNT(*)::int n FROM reply_sources WHERE campaign_id=$1",
      [id],
    );
    if (count.rows[0].n >= 5) throw new ApiError(409, "maximum 5 sources");
    return (
      await c.query(
        "INSERT INTO reply_sources(campaign_id,type,value,priority) VALUES($1,$2,$3,$4) RETURNING *",
        [id, input.type, input.value, input.priority],
      )
    ).rows[0];
  });
}
export async function approveDraft(user: string, id: string, raw: unknown) {
  const input = z
    .object({ reply_text: z.string().max(2000).optional() })
    .strict()
    .parse(raw);
  return tx(async (c) => {
    const row = await c.query<{
      id: string;
      author_id: string;
      reply_text: string;
      status: string;
    }>(
      "SELECT d.* FROM reply_drafts d JOIN reply_campaigns c ON c.id=d.campaign_id WHERE d.id=$1 AND c.user_id=$2 FOR UPDATE OF d",
      [idParam(id), user],
    );
    const draft = row.rows[0];
    if (!draft) throw new ApiError(404, "draft not found");
    if (draft.status !== "review")
      throw new ApiError(409, "draft is not awaiting review");
    const consent = await c.query(
      "SELECT id FROM reply_consents WHERE user_id=$1 AND author_id=$2 AND expires_at>now()",
      [user, draft.author_id],
    );
    if (!consent.rowCount)
      throw new ApiError(409, "record recipient consent before approval");
    const text = validateReply(input.reply_text ?? draft.reply_text);
    return (
      await c.query(
        "UPDATE reply_drafts SET reply_text=$1,status='approved',approved_at=now() WHERE id=$2 RETURNING *",
        [text, id],
      )
    ).rows[0];
  });
}
export async function stats(user: string, campaign?: string, account?: string) {
  if (campaign) await campaignFor(user, campaign);
  if (account) await accountFor(user, account);
  // Ownership has been checked above. Use a concrete predicate instead of nullable ORs.
  if (campaign && account) return q(
    "SELECT status,COUNT(*)::int count FROM reply_drafts WHERE campaign_id=$1 AND account_id=$2 GROUP BY status",[campaign,account],
  );
  if (campaign) return q(
    "SELECT status,COUNT(*)::int count FROM reply_drafts WHERE campaign_id=$1 GROUP BY status",[campaign],
  );
  if (account) return q(
    "SELECT status,COUNT(*)::int count FROM reply_drafts WHERE account_id=$1 GROUP BY status",[account],
  );
  return q(
    "SELECT d.status,COUNT(*)::int count FROM reply_drafts d JOIN reply_campaigns c ON c.id=d.campaign_id WHERE c.user_id=$1 GROUP BY d.status",
    [user],
  );
}
