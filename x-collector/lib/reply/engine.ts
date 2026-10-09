import { q, q1, tx } from "../trade/pg";
import {
  Account,
  Campaign,
  Lore,
  Tweet,
  Settings,
  Filters,
  sleeping,
  filterTweet,
} from "./model";
import { XClient, XError, PublishUncertainError } from "./x-api";
import { generateReply, validateReply } from "./llm";
import { alert } from "./service";
import { testProxy, ProxyConfig } from "./proxy";
import { unseal } from "./secrets";
export function publicationEnabled(): boolean {
  return (
    process.env.REPLY_PUBLISH_ENABLED === "true" &&
    (process.env.REPLY_X_AI_APPROVAL_REF?.trim().length ?? 0) >= 10
  );
}
export async function reservePublication(
  accountId: string,
  now = new Date(),
): Promise<{ id: string; tweet_id: string; reply_text: string } | null> {
  if (!publicationEnabled()) return null;
  return tx(async (c) => {
    // Serialize rate reservations across all account workers, including daily global cap.
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtext('reply-publication-budget'))",
    );
    const result = await c.query<
      Account & {
        settings_json: unknown;
        campaign_status: string;
        next_reply_at: string | null;
      }
    >(
      "SELECT a.*,c.settings_json,c.status campaign_status FROM reply_accounts a JOIN reply_campaigns c ON c.account_id=a.id WHERE a.id=$1 FOR UPDATE OF a,c",
      [accountId],
    );
    const account = result.rows[0];
    if (
      !account ||
      account.status !== "ready" ||
      account.proxy_status === "dead" ||
      account.campaign_status !== "running"
    )
      return null;
    if (
      (account.cooldown_until &&
        Date.parse(account.cooldown_until) > now.getTime()) ||
      (account.next_reply_at &&
        Date.parse(account.next_reply_at) > now.getTime())
    )
      return null;
    const settings = Settings.parse(account.settings_json);
    if (sleeping(settings, account.timezone, now)) return null;
    const hour = Math.floor(now.getTime() / 3600000),
      day = Math.floor(hour / 24) * 24;
    const usage = await c.query<{
      hour_count: number;
      day_count: number;
      global_day: number;
    }>(
      `SELECT
    COALESCE(SUM(count) FILTER(WHERE account_id=$1 AND hour_epoch=$2),0)::int AS hour_count,
    COALESCE(SUM(count) FILTER(WHERE account_id=$1),0)::int AS day_count,
    COALESCE(SUM(count),0)::int global_day FROM reply_rate_limits WHERE hour_epoch >= $3`,
      [accountId, hour, day],
    );
    const budget = usage.rows[0];
    if (
      budget.hour_count >= settings.hourly_limit ||
      budget.day_count >= settings.daily_limit ||
      budget.global_day >= 1000
    )
      return null;
    const draft = await c.query<{
      id: string;
      tweet_id: string;
      reply_text: string;
    }>(
      `SELECT d.id,d.tweet_id,d.reply_text FROM reply_drafts d JOIN reply_consents opt ON opt.user_id=$2 AND opt.author_id=d.author_id AND opt.expires_at>$3
   WHERE d.account_id=$1 AND d.status='approved' ORDER BY d.created_at,d.id LIMIT 1 FOR UPDATE OF d`,
      [accountId, account.user_id, now],
    );
    const row = draft.rows[0];
    if (!row) return null;
    validateReply(row.reply_text);
    await c.query(
      "INSERT INTO reply_rate_limits(account_id,hour_epoch,count) VALUES($1,$2,1) ON CONFLICT(account_id,hour_epoch) DO UPDATE SET count=reply_rate_limits.count+1",
      [accountId, hour],
    );
    await c.query(
      "UPDATE reply_drafts SET status='publishing',publish_started_at=$1 WHERE id=$2",
      [now, row.id],
    );
    await c.query("UPDATE reply_accounts SET next_reply_at=$1 WHERE id=$2", [
      new Date(now.getTime() + settings.delay_seconds * 1000),
      accountId,
    ]);
    return row;
  });
}
export async function handleXError(
  account: Account,
  error: unknown,
): Promise<void> {
  if (error instanceof XError) {
    if (error.status === 401 || error.status === 403) {
      const status = error.status === 401 ? "needs_auth" : "blocked";
      await tx(async (c) => {
        await c.query("UPDATE reply_accounts SET status=$1 WHERE id=$2", [
          status,
          account.id,
        ]);
        await c.query(
          "UPDATE reply_campaigns SET status='stopped' WHERE account_id=$1",
          [account.id],
        );
      });
      await alert(
        account.user_id,
        account.id,
        status,
        "X authorization or access rejected; campaign stopped",
      );
    } else if (error.status === 429) {
      await q("UPDATE reply_accounts SET cooldown_until=$1 WHERE id=$2", [
        new Date(Math.max(error.retryAt ?? 0, Date.now() + 15 * 60000)),
        account.id,
      ]);
      await alert(
        account.user_id,
        account.id,
        "rate_limit",
        "X rate limit reached; waiting for reset without switching accounts",
      );
    }
  }
}
export async function healthCheck(account: Account): Promise<boolean> {
  if (account.proxy_encrypted) {
    try {
      const checked = await testProxy(
        unseal<ProxyConfig>(account.proxy_encrypted),
      );
      await q(
        "UPDATE reply_accounts SET proxy_status='ready',proxy_latency_ms=$1 WHERE id=$2",
        [checked.latency_ms, account.id],
      );
    } catch {
      await tx(async (c) => {
        await c.query(
          "UPDATE reply_accounts SET proxy_status='dead',status='paused' WHERE id=$1",
          [account.id],
        );
        await c.query(
          "UPDATE reply_campaigns SET status='stopped' WHERE account_id=$1",
          [account.id],
        );
      });
      await alert(
        account.user_id,
        account.id,
        "proxy_dead",
        "Proxy unavailable; account and campaign paused",
      );
      return false;
    }
  }
  try {
    const me = await XClient.fromAccount(account).me();
    if (me.id !== account.x_user_id) {
      await q("UPDATE reply_accounts SET status='needs_auth' WHERE id=$1", [
        account.id,
      ]);
      await q(
        "UPDATE reply_campaigns SET status='stopped' WHERE account_id=$1",
        [account.id],
      );
      await alert(
        account.user_id,
        account.id,
        "identity_mismatch",
        "X account identity changed; update credentials",
      );
      return false;
    }
    await q("UPDATE reply_accounts SET last_health_at=now() WHERE id=$1", [
      account.id,
    ]);
    return true;
  } catch (error) {
    await handleXError(account, error);
    await alert(
      account.user_id,
      account.id,
      "health_failed",
      "X account health check failed",
    );
    return false;
  }
}
export async function collect(
  campaign: Campaign,
  account: Account,
): Promise<void> {
  const sources = await q<{
    id: string;
    type: "search" | "list";
    value: string;
    since_id: string | null;
    next_token: string | null;
    page_newest_id: string | null;
  }>(
    "SELECT * FROM reply_sources WHERE campaign_id=$1 ORDER BY priority DESC,id",
    [campaign.id],
  );
  const client = XClient.fromAccount(account);
  for (const source of sources) {
    try {
      const page = await client.source(
        source.type,
        source.value,
        source.since_id,
        source.next_token,
      );
      await tx(async (c) => {
        const tweets = page.tweets.filter(tweet => tweet.author_id !== account.x_user_id);
        if (tweets.length) await c.query(
          `INSERT INTO reply_drafts(campaign_id,account_id,tweet_id,author_id,tweet_json)
           SELECT $1,$2,t->>'id',t->>'author_id',t FROM jsonb_array_elements($3::jsonb) t
           ON CONFLICT(account_id,tweet_id) DO NOTHING`,
          [campaign.id,account.id,JSON.stringify(tweets)],
        );
        const newest =
          source.page_newest_id ?? page.newestId ?? source.since_id;
        await c.query(
          "UPDATE reply_sources SET since_id=$1,next_token=$2,page_newest_id=$3 WHERE id=$4",
          [
            page.nextToken ? source.since_id : newest,
            page.nextToken ?? null,
            page.nextToken ? newest : null,
            source.id,
          ],
        );
      });
    } catch (error) {
      await handleXError(account, error);
      await alert(
        account.user_id,
        account.id,
        "source_failed",
        "Source " + source.id + " failed; other sources remain independent",
      );
      if (error instanceof XError && [401, 403, 429].includes(error.status))
        return;
    }
  }
}
export async function draftReplies(
  campaign: Campaign,
  account: Account,
): Promise<void> {
  const filters = Filters.parse(campaign.filters_json),
    settings = Settings.parse(campaign.settings_json);
  if (campaign.status !== "running" || account.status !== "ready" ||
      sleeping(settings, account.timezone) ||
      (account.cooldown_until && Date.parse(account.cooldown_until) > Date.now())) return;
  const now = Date.now();
  const hour = Math.floor(now / 3600000), day = Math.floor(hour / 24) * 24;
  const usage = await q1<{hour_count: number; day_count: number; global_day: number}>(
    `SELECT COALESCE(SUM(count) FILTER (WHERE account_id=$1 AND hour_epoch=$2),0)::int hour_count,
     COALESCE(SUM(count) FILTER (WHERE account_id=$1),0)::int day_count,
     COALESCE(SUM(count),0)::int global_day FROM reply_rate_limits WHERE hour_epoch >= $3`,
    [account.id, hour, day],
  );
  const quota = Math.max(0, Math.min(settings.hourly_limit - (usage?.hour_count ?? 0),
    settings.daily_limit - (usage?.day_count ?? 0), 1000 - (usage?.global_day ?? 0)));
  // Bound paid work even in draft-only mode. Publication still reserves its own atomic quota.
  if (!quota) return;
  const blacklist = await q<{ type: string; value: string }>(
    "SELECT type,value FROM reply_blacklists WHERE campaign_id=$1",
    [campaign.id],
  );
  const backlog = await q<{tweet_json: Tweet}>(
    "SELECT tweet_json FROM reply_drafts WHERE account_id=$1 AND status IN ('review','approved','publishing') ORDER BY created_at DESC LIMIT 100",
    [account.id],
  );
  const queued = backlog.filter(row => !filterTweet(row.tweet_json, filters, blacklist)).length;
  const capacity = Math.max(0, Math.min(3, quota) - queued);
  if (!capacity) return;
  const lore = await q1<Lore>(
    "SELECT * FROM reply_lore WHERE id=$1 AND user_id=$2",
    [campaign.lore_id, campaign.user_id],
  );
  if (!lore) throw new Error("campaign lore missing");
  const pending = await q<{ id: string; tweet_json: Tweet }>(
    "SELECT id,tweet_json FROM reply_drafts WHERE campaign_id=$1 AND status='pending' ORDER BY created_at,id LIMIT 20",
    [campaign.id],
  );
  let generated = 0;
  for (const row of pending) {
    // Too-young posts stay queued, instead of being lost when source watermark advances.
    const age = (Date.now() - Date.parse(row.tweet_json.created_at)) / 60000;
    if (age >= 0 && age < filters.min_age) continue;
    const reason = filterTweet(row.tweet_json, filters, blacklist);
    if (reason) {
      await q(
        "UPDATE reply_drafts SET status='rejected',last_error=$1 WHERE id=$2 AND status='pending'",
        ["filter: " + reason, row.id],
      );
      continue;
    }
    if (generated >= capacity) break;
    // Avoid paying for a draft whose earliest queue slot is already past its expiry.
    const earliest = Math.max(Date.now(), account.next_reply_at ? Date.parse(account.next_reply_at) : 0) +
      (queued + generated) * settings.delay_seconds * 1000;
    if (earliest >= Date.parse(row.tweet_json.created_at) + filters.max_age * 60000) continue;
    try {
      const text = await generateReply(lore, row.tweet_json);
      generated++;
      // Re-read campaign after LLM delay: stop/change takes effect before publication.
      const active = await q1<{ status: string; settings_json: unknown }>(
        "SELECT status,settings_json FROM reply_campaigns WHERE id=$1",
        [campaign.id],
      );
      const consent = await q1(
        "SELECT id FROM reply_consents WHERE user_id=$1 AND author_id=$2 AND expires_at>now()",
        [campaign.user_id, row.tweet_json.author_id],
      );
      const auto =
        settings.auto_publish &&
        active?.status === "running" &&
        Settings.parse(active.settings_json).auto_publish &&
        consent &&
        publicationEnabled();
      await q(
        "UPDATE reply_drafts SET reply_text=$1,status=$2,approved_at=CASE WHEN $2='approved' THEN now() ELSE NULL END WHERE id=$3 AND status='pending'",
        [text, auto ? "approved" : "review", row.id],
      );
    } catch {
      await q(
        "UPDATE reply_drafts SET status='failed',last_error='LLM generation failed' WHERE id=$1 AND status='pending'",
        [row.id],
      );
      await alert(
        account.user_id,
        account.id,
        "llm_failed",
        "Reply generation failed; check LLM configuration",
      );
      break;
    }
  }
}
export async function publishNext(account: Account): Promise<void> {
  const reserved = await reservePublication(account.id);
  if (!reserved) return;
  const campaign = await q1<Campaign>(
    "SELECT * FROM reply_campaigns WHERE account_id=$1",
    [account.id],
  );
  const draft = await q1<{ tweet_json: Tweet }>(
    "SELECT tweet_json FROM reply_drafts WHERE id=$1",
    [reserved.id],
  );
  const blacklist = campaign
    ? await q<{ type: string; value: string }>(
        "SELECT type,value FROM reply_blacklists WHERE campaign_id=$1",
        [campaign.id],
      )
    : [];
  const reason =
    campaign && draft
      ? filterTweet(
          draft.tweet_json,
          Filters.parse(campaign.filters_json),
          blacklist,
        )
      : "missing campaign";
  if (reason || campaign?.status !== "running") {
    await q(
      "UPDATE reply_drafts SET status='rejected',last_error=$1 WHERE id=$2",
      ["publication cancelled: " + (reason ?? "campaign stopped"), reserved.id],
    );
    return;
  }
  try {
    const id = await XClient.fromAccount(account).publish(
      reserved.tweet_id,
      reserved.reply_text,
    );
    await q(
      "UPDATE reply_drafts SET status='published',published_at=now(),x_reply_id=$1,last_error=NULL WHERE id=$2 AND status='publishing'",
      [id, reserved.id],
    );
  } catch (error) {
    await handleXError(account, error);
    const uncertain =
      error instanceof PublishUncertainError || !(error instanceof XError);
    await q(
      "UPDATE reply_drafts SET status=$1,last_error=$2 WHERE id=$3 AND status='publishing'",
      [
        uncertain
          ? "uncertain"
          : error instanceof XError && error.status === 429
            ? "approved"
            : "failed",
        uncertain
          ? "publication outcome unknown; reconcile manually"
          : "X HTTP " + (error as XError).status,
        reserved.id,
      ],
    );
    await alert(
      account.user_id,
      account.id,
      uncertain ? "publish_uncertain" : "publish_failed",
      uncertain
        ? "Publication outcome unknown; do not retry before reconciliation"
        : "X publication rejected",
    );
  }
}
