import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { z, ZodError } from "zod";
import { q, q1 } from "../trade/pg";
import { authenticate } from "./auth";
import * as service from "./service";
import { Filters, Lore, Tweet } from "./model";
import { generateReply } from "./llm";
import { testProxy, ProxyConfig } from "./proxy";
import { unseal } from "./secrets";
import { postFields, XClient } from "./x-api";
export const publicDir = path.resolve(__dirname, "../../public");
// The compiled build keeps public assets outside dist.
const assetDir = __dirname.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(__dirname, "../../../public")
  : publicDir;
async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new service.ApiError(413, "request too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new service.ApiError(400, "invalid JSON");
  }
}
export async function handleReplyRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/reply" || url.pathname === "/reply.js") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.end();
      return true;
    }
    res.setHeader(
      "Content-Type",
      url.pathname === "/reply"
        ? "text/html; charset=utf-8"
        : "application/javascript; charset=utf-8",
    );
    res.end(
      await fs.readFile(
        path.join(
          assetDir,
          url.pathname === "/reply" ? "reply.html" : "reply.js",
        ),
      ),
    );
    return true;
  }
  const endpoint = url.pathname.replace(/^\/api\/reply(?=\/)/, "/api");
  if (
    !url.pathname.startsWith("/api/reply/") &&
    !url.pathname.startsWith("/api/")
  )
    return false;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    const header = req.headers["x-reply-token"] ?? req.headers.authorization;
    const token =
      typeof header === "string" ? header.replace(/^Bearer /, "") : "";
    let auth: { userId: string; jti: string };
    try {
      auth = await authenticate(token);
    } catch {
      throw new service.ApiError(401, "valid Reply Guy token required");
    }
    const user = auth.userId,
      method = req.method ?? "GET";
    let data: unknown;
    let match: RegExpMatchArray | null;
    const input = () => body(req);
    if (endpoint === "/api/me" && method === "GET")
      data = await q1("SELECT id,telegram_id FROM reply_users WHERE id=$1", [
        user,
      ]);
    else if (endpoint === "/api/token/revoke" && method === "POST") {
      await q(
        "UPDATE reply_tokens SET revoked_at=now() WHERE jti=$1 AND user_id=$2",
        [auth.jti, user],
      );
      data = { revoked: true };
    } else if (endpoint === "/api/accounts" && method === "GET")
      data = await service.publicAccounts(user);
    else if (endpoint === "/api/accounts" && method === "POST")
      data = await service.addAccount(user, await input());
    else if (
      (match = endpoint.match(/^\/api\/accounts\/(\d+)$/)) &&
      method === "PATCH"
    )
      data = await service.updateAccount(user, match[1], await input());
    else if (
      (match = endpoint.match(/^\/api\/accounts\/(\d+)$/)) &&
      method === "DELETE"
    ) {
      await service.accountFor(user, match[1]);
      await q("DELETE FROM reply_accounts WHERE id=$1 AND user_id=$2", [
        match[1],
        user,
      ]);
      data = { deleted: true };
    } else if (
      (match = endpoint.match(/^\/api\/accounts\/(\d+)\/proxy$/)) &&
      method === "POST"
    )
      data = await service.setProxy(user, match[1], await input());
    else if (
      (match = endpoint.match(/^\/api\/accounts\/(\d+)\/proxy\/(test|status)$/))
    ) {
      const account = await service.accountFor(user, match[1]);
      if (match[2] === "status" && method === "GET")
        data = { status: account.proxy_status };
      else if (match[2] === "test" && method === "POST") {
        if (!account.proxy_encrypted)
          throw new service.ApiError(409, "no proxy configured");
        try {
          data = await testProxy(unseal<ProxyConfig>(account.proxy_encrypted));
          await q(
            "UPDATE reply_accounts SET proxy_status='ready',proxy_latency_ms=$1 WHERE id=$2",
            [(data as { latency_ms: number }).latency_ms, account.id],
          );
        } catch {
          await q(
            "UPDATE reply_accounts SET proxy_status='dead',status='paused' WHERE id=$1",
            [account.id],
          );
          await q(
            "UPDATE reply_campaigns SET status='stopped' WHERE account_id=$1",
            [account.id],
          );
          await service.alert(
            user,
            account.id,
            "proxy_dead",
            "Proxy unavailable; account paused",
          );
          throw new service.ApiError(502, "proxy check failed");
        }
      } else throw new service.ApiError(405, "method not allowed");
    } else if (endpoint === "/api/lore" && method === "GET")
      data = await q("SELECT * FROM reply_lore WHERE user_id=$1 ORDER BY id", [
        user,
      ]);
    else if (endpoint === "/api/lore" && method === "POST")
      data = await service.addLore(user, await input());
    else if (
      (match = endpoint.match(/^\/api\/lore\/(\d+)$/)) &&
      method === "PATCH"
    )
      data = await service.patchLore(user, match[1], await input());
    else if ((match = endpoint.match(/^\/api\/lore\/(\d+)\/examples$/))) {
      if (method === "POST")
        data = await service.addExample(user, match[1], await input());
      else if (method === "GET")
        data = await q(
          "SELECT e.id,e.tweet_text,e.reply_text,e.embedding_model FROM reply_examples e JOIN reply_lore l ON l.id=e.lore_id WHERE l.id=$1 AND l.user_id=$2 ORDER BY e.id",
          [match[1], user],
        );
      else throw new service.ApiError(405, "method not allowed");
    } else if (endpoint === "/api/campaigns" && method === "GET")
      data = await q(
        "SELECT * FROM reply_campaigns WHERE user_id=$1 ORDER BY id",
        [user],
      );
    else if (endpoint === "/api/campaigns" && method === "POST")
      data = await service.createCampaign(user, await input());
    else if (
      (match = endpoint.match(/^\/api\/campaigns\/(\d+)$/)) &&
      method === "PATCH"
    )
      data = await service.patchCampaign(user, match[1], await input());
    else if (
      (match = endpoint.match(/^\/api\/campaigns\/(\d+)\/(start|stop)$/)) &&
      method === "POST"
    ) {
      if (match[2] === "start")
        data = await service.startCampaign(user, match[1]);
      else {
        await service.campaignFor(user, match[1]);
        await q(
          "UPDATE reply_campaigns SET status='stopped' WHERE id=$1 AND user_id=$2",
          [match[1], user],
        );
        data = { status: "stopped" };
      }
    } else if ((match = endpoint.match(/^\/api\/campaigns\/(\d+)\/sources$/))) {
      if (method === "POST")
        data = await service.addSource(user, match[1], await input());
      else if (method === "GET") {
        await service.campaignFor(user, match[1]);
        data = await q(
          "SELECT * FROM reply_sources WHERE campaign_id=$1 ORDER BY priority DESC,id",
          [match[1]],
        );
      } else throw new service.ApiError(405, "method not allowed");
    } else if (
      (match = endpoint.match(/^\/api\/sources\/(\d+)$/)) &&
      method === "DELETE"
    ) {
      const source = await q1(
        "DELETE FROM reply_sources s USING reply_campaigns c WHERE s.id=$1 AND s.campaign_id=c.id AND c.user_id=$2 RETURNING s.id",
        [match[1], user],
      );
      if (!source) throw new service.ApiError(404, "source not found");
      data = { deleted: true };
    } else if (
      (match = endpoint.match(/^\/api\/campaigns\/(\d+)\/filters$/)) &&
      method === "PATCH"
    ) {
      const campaign = await service.campaignFor(user, match[1]);
      const filters = Filters.parse({
        ...campaign.filters_json,
        ...z.record(z.unknown()).parse(await input()),
      });
      await q(
        "UPDATE reply_campaigns SET filters_json=$1::jsonb WHERE id=$2 AND user_id=$3",
        [JSON.stringify(filters), match[1], user],
      );
      data = filters;
    } else if (
      (match = endpoint.match(/^\/api\/campaigns\/(\d+)\/blacklists$/))
    ) {
      await service.campaignFor(user, match[1]);
      if (method === "GET")
        data = await q(
          "SELECT * FROM reply_blacklists WHERE campaign_id=$1 ORDER BY id",
          [match[1]],
        );
      else if (method === "POST") {
        const v = z
          .object({
            type: z.enum(["word", "account"]),
            value: z.string().trim().min(1).max(200),
          })
          .strict()
          .parse(await input());
        data = await q1(
          "INSERT INTO reply_blacklists(campaign_id,type,value) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *",
          [match[1], v.type, v.value],
        );
      } else throw new service.ApiError(405, "method not allowed");
    } else if (
      (match = endpoint.match(/^\/api\/blacklists\/(\d+)$/)) &&
      method === "DELETE"
    ) {
      const row = await q1(
        "DELETE FROM reply_blacklists b USING reply_campaigns c WHERE b.id=$1 AND b.campaign_id=c.id AND c.user_id=$2 RETURNING b.id",
        [match[1], user],
      );
      if (!row) throw new service.ApiError(404, "blacklist item not found");
      data = { deleted: true };
    } else if (
      (match = endpoint.match(/^\/api\/(accounts|campaigns)\/(\d+)\/stats$/)) &&
      method === "GET"
    )
      data = await service.stats(
        user,
        match[1] === "campaigns" ? match[2] : undefined,
        match[1] === "accounts" ? match[2] : undefined,
      );
    else if (endpoint === "/api/stats" && method === "GET")
      data = await service.stats(user);
    else if (endpoint === "/api/alerts" && method === "GET")
      data = await q(
        "SELECT id,account_id,type,message,created_at,delivered_at FROM reply_alerts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
        [user],
      );
    else if (endpoint === "/api/consents" && method === "GET")
      data = await q(
        "SELECT * FROM reply_consents WHERE user_id=$1 ORDER BY id",
        [user],
      );
    else if (endpoint === "/api/consents" && method === "POST") {
      const v = z
        .object({
          author_id: z.string().regex(/^\d{1,25}$/),
          evidence: z.string().trim().min(10).max(2000),
          expires_at: z.string().datetime(),
        })
        .strict()
        .parse(await input());
      if (Date.parse(v.expires_at) <= Date.now())
        throw new service.ApiError(400, "consent expiry must be in the future");
      data = await q1(
        "INSERT INTO reply_consents(user_id,author_id,evidence,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,author_id) DO UPDATE SET evidence=EXCLUDED.evidence,expires_at=EXCLUDED.expires_at RETURNING *",
        [user, v.author_id, v.evidence, v.expires_at],
      );
    } else if (
      (match = endpoint.match(/^\/api\/consents\/(\d+)$/)) &&
      method === "DELETE"
    ) {
      await q("DELETE FROM reply_consents WHERE id=$1 AND user_id=$2", [
        match[1],
        user,
      ]);
      data = { deleted: true };
    } else if (endpoint === "/api/drafts" && method === "GET")
      data = await q(
        "SELECT d.* FROM reply_drafts d JOIN reply_campaigns c ON c.id=d.campaign_id WHERE c.user_id=$1 ORDER BY d.created_at DESC LIMIT 100",
        [user],
      );
    else if (
      (match = endpoint.match(
        /^\/api\/drafts\/(\d+)\/(approve|reject|regenerate|reconcile)$/,
      )) &&
      method === "POST"
    ) {
      const id = match[1],
        action = match[2];
      if (action === "approve")
        data = await service.approveDraft(user, id, await input());
      else {
        const draft = await q1<{
          id: string;
          campaign_id: string;
          account_id: string;
          tweet_json: Tweet;
          reply_text: string;
          status: string;
        }>(
          "SELECT d.* FROM reply_drafts d JOIN reply_campaigns c ON c.id=d.campaign_id WHERE d.id=$1 AND c.user_id=$2",
          [id, user],
        );
        if (!draft) throw new service.ApiError(404, "draft not found");
        if (action === "reject") {
          const rows = await q(
            "UPDATE reply_drafts SET status='rejected' WHERE id=$1 AND status IN ('pending','review','approved','failed') RETURNING id",
            [id],
          );
          if (!rows.length)
            throw new service.ApiError(
              409,
              "draft is already publishing or finalized",
            );
          data = { rejected: true };
        } else if (action === "regenerate") {
          if (!["review", "failed"].includes(draft.status))
            throw new service.ApiError(409, "draft cannot be regenerated");
          const campaign = await service.campaignFor(user, draft.campaign_id);
          const lore = await q1<Lore>(
            "SELECT * FROM reply_lore WHERE id=$1 AND user_id=$2",
            [campaign.lore_id, user],
          );
          if (!lore) throw new service.ApiError(404, "lore not found");
          const text = await generateReply(lore, draft.tweet_json);
          data = await q1(
            "UPDATE reply_drafts SET reply_text=$1,status='review',last_error=NULL WHERE id=$2 AND status IN ('review','failed') RETURNING *",
            [text, id],
          );
          if (!data) throw new service.ApiError(409, "draft state changed");
        } else {
          if (draft.status !== "uncertain")
            throw new service.ApiError(
              409,
              "only uncertain publications need reconciliation",
            );
          const v = z
            .object({ x_reply_id: z.string().regex(/^\d{1,25}$/) })
            .strict()
            .parse(await input());
          const account = await service.accountFor(user, draft.account_id);
          const reply = (await XClient.fromAccount(account).call(
            "/2/tweets/" +
              v.x_reply_id +
              "?" + postFields(),
          )) as {
            data?: {
              author_id: string;
              text: string;
              referenced_tweets?: Array<{ type: string; id: string }>;
              referenced_posts?: Array<{ type: string; id: string }>;
            };
          };
          if (
            reply.data?.author_id !== account.x_user_id ||
            reply.data.text !== draft.reply_text ||
            !(reply.data.referenced_posts ?? reply.data.referenced_tweets)?.some(
              (r) => r.type === "replied_to" && r.id === draft.tweet_json.id,
            )
          )
            throw new service.ApiError(
              409,
              "reply does not match this account and draft",
            );
          await q(
            "UPDATE reply_drafts SET status='published',x_reply_id=$1,published_at=now(),last_error=NULL WHERE id=$2 AND status='uncertain'",
            [v.x_reply_id, id],
          );
          data = { reconciled: true };
        }
      }
    } else
      throw new service.ApiError(
        404,
        "endpoint not found or method not supported",
      );
    res.end(JSON.stringify(data ?? {}));
  } catch (error) {
    const code = (error as { code?: string }).code;
    const status =
      error instanceof service.ApiError
        ? error.status
        : error instanceof ZodError
          ? 400
          : code === "23505"
            ? 409
            : 502;
    const message =
      error instanceof service.ApiError
        ? error.message
        : error instanceof ZodError
          ? "invalid request fields"
          : code === "23505"
            ? "resource already exists or proxy is assigned to another account"
            : "operation failed; check configured services";
    res.statusCode = status;
    res.end(JSON.stringify({ error: message }));
  }
  return true;
}
