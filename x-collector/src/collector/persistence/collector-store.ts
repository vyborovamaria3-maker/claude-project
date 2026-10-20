import { TweetSchema, ProfileSchema } from "../../../lib/trade/schemas";
import { processTweetEntities } from "../../intelligence/entities/processor";
import { tx } from "../../../lib/trade/pg";
import { log } from "../../../lib/trade/logger";
import { source, sourceId, rawPage, recordRawPage, storePage } from "../../../lib/archive/store";
import { Page } from "../../../lib/archive/model";
import {recordRaw,recordRawBatch} from '../../../lib/trade/intelligence-store';
import type { PoolClient } from "pg";
import { emitXTweetOutbox } from "./intelligence-outbox";
import { emitXTokenLinksInvalidation, xVerifiedTokenLinksEnabled } from "./verified-token-links";
import {createHash} from "node:crypto";
export interface PersistenceLease { workerId: string; attempt: number; accountName: string; accountOwner: string; }
async function assertPersistenceLease(client: PoolClient, taskId: number | undefined, lease?: PersistenceLease) {
  if (!lease) return;
  const now = Date.now();
  const task = await client.query(`SELECT id FROM x_tasks WHERE id=$1 AND claimed_by=$2
    AND attempts=$3 AND status='claimed' AND lease_expires_at>$4 FOR UPDATE`,
    [taskId, lease.workerId, lease.attempt, now]);
  if (!task.rows.length) throw new Error("task lease lost before persistence");
  const account = await client.query(`SELECT name FROM x_accounts WHERE name=$1
    AND account_claimed_by=$2 AND account_busy_until>$3 FOR UPDATE`,
    [lease.accountName, lease.accountOwner, now]);
  if (!account.rows.length) throw new Error("account lease lost before persistence");
}
export interface TweetPersistenceOptions {
  client?: PoolClient;
  transport?: "browser" | "http";
  /** Source response envelope without HTTP auth headers/cookies, when exposed by the engine. */
  rawResponse?: unknown;
  /** Large browser DOM batches are split into SQL chunks inside ONE transaction. */
  atomicBrowserBatch?: boolean;
}
export async function persistTweets(mint: string | null, tweets: unknown[], sourceQuery: string | null = null, taskId?: number, collectorAccount?: string, lease?: PersistenceLease, options: TweetPersistenceOptions = {}): Promise<number> {
  let newTaskLinks = 0;
  const now = Date.now();
  const fromHttp = options.transport === "http";
  const httpSourceUrl = "https://x.com/i/api/graphql";
  let rawCapture: { hash: string; responseHash?: string; path: string; parserVersion?: string } | undefined;
  let rawCaptureSourceId: string | undefined;
  if (options.rawResponse !== undefined) {
    const rawSourceKey = await source(
      fromHttp ? "X HTTP collector" : "X browser collector",
      fromHttp ? httpSourceUrl : "https://x.com",
      "X platform terms", "x", { transport: fromHttp ? "HTTP GraphQL" : "visible DOM" },
    );
    const received = new Date(now);
    // Capture before TweetSchema parsing so schema drift does not destroy the source evidence.
    rawCapture = await rawPage({
      capture_format_version: 1,
      parser_version: process.env.X_COLLECTOR_PARSER_VERSION ?? "unversioned",
      transport: fromHttp ? "http" : "browser",
      collection: { task_id: taskId ?? null, collector_account: collectorAccount ?? null },
      request: { source_query: sourceQuery, mint },
      received_at: received.toISOString(),
      raw_items: tweets,
      source_response: options.rawResponse,
    });
    rawCaptureSourceId = rawSourceKey;
    await recordRawPage(rawSourceKey, rawCapture, received, undefined, { parseStatus: "captured", responseStatus: "unknown" });
  }
  const valid: Array<ReturnType<typeof TweetSchema.parse>> = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const raw of tweets) {
    const parsed = TweetSchema.safeParse(raw);
    if (parsed.success) { if (!seen.has(parsed.data.id)) { valid.push(parsed.data); seen.add(parsed.data.id); } }
    else rejected++;
  }
  if (rejected > 0) {
    if (rawCapture && rawCaptureSourceId) {
      await recordRawPage(rawCaptureSourceId, rawCapture, new Date(now), undefined, {
        parseStatus: valid.length > 0 ? "partial" : "failed",
        responseStatus: valid.length > 0 ? "nonempty" : "error",
      });
    }
    throw new Error(`collector rejected ${rejected} malformed tweets`);
  }
  if (rawCapture && rawCaptureSourceId) {
    await recordRawPage(rawCaptureSourceId, rawCapture, new Date(now), undefined, {
      parseStatus: "parsed",
      responseStatus: valid.length === 0 ? "unknown" : "nonempty",
    });
  }
  if (valid.length === 0) return 0;

  const BATCH = 200;
  // A page checkpoint and all of its posts must share one transaction.
  if (options.client && valid.length > BATCH &&
      !(options.atomicBrowserBatch === true && options.transport !== "http" && valid.length <= 1000))
    throw new Error("Collector: page exceeds transactional batch limit");
  // archive.sourceId hashes URL/license/kind (not name). Distinct URLs keep
  // HTTP observations from inheriting the old browser-only source metadata.
  const sourceKey = fromHttp
    ? sourceId(httpSourceUrl, "X platform terms", "x")
    : await source("X browser collector", "https://x.com", "X platform terms", "x", { transport: "visible DOM" }, options.client);

  for (let i = 0; i < valid.length; i += BATCH) {
    const chunk = valid.slice(i, i + BATCH);
    if (chunk.length === 0) continue;
    const received = new Date(now);
    const raw = rawCapture ?? await rawPage({
      capture_format_version: 1,
      parser_version: process.env.X_COLLECTOR_PARSER_VERSION ?? "unversioned",
      transport: fromHttp ? "http" : "browser",
      collection: { task_id: taskId ?? null, collector_account: collectorAccount ?? null },
      request: { source_query: sourceQuery, mint },
      received_at: received.toISOString(),
      tweets: chunk,
    });
    // Tweets y vínculos mint se insertan en una sola transacción: un fallo a mitad
    // no deja tweets sin su link (ni viceversa).
    const writeChunk = async (client: PoolClient): Promise<number> => {
      let newlyLinked = 0;
      await assertPersistenceLease(client, taskId, lease);
      // HTTP provenance must be committed or rolled back with its page/cursor.
      // Browser-source behavior is deliberately unchanged.
      if (fromHttp) {
        await source("X HTTP collector", httpSourceUrl, "X platform terms", "x",
          { transport: "HTTP GraphQL" }, client);
      }
      await recordRawBatch(client,chunk.map(t=>({eventType:'TWEET',externalId:t.id,payload:t,collectedAt:new Date(t.observedAt??now),collectorAccount:collectorAccount??null})));
      // Only when enabled: lock existing tweets before the upsert so a proof
      // worker cannot commit a stale mint link between reading old text and
      // storing the new source revision. Never perform RPC inside this tx.
      const oldRows=xVerifiedTokenLinksEnabled()
        ? (await client.query<{tweet_id:string;text:string|null;author_id:string|null;posted_at:string|number|null}>(
          "SELECT tweet_id,text,author_id,posted_at FROM twitter_tweets " +
          "WHERE tweet_id=ANY($1::text[]) ORDER BY tweet_id FOR UPDATE",
          [chunk.map(t=>t.id)],
        )).rows
        : [];
      const previousById=new Map(oldRows.map(row=>[row.tweet_id,row]));

      const values: unknown[] = [];
      const placeholders = chunk.map((t, j) => {
        const off = j * 14;
        values.push(
          t.id, t.authorId ?? null, t.authorHandle.toLowerCase(), t.text, t.url,
          t.views, t.likes, t.retweets, t.replies,
          t.isVerified, t.postedAt, now, t.observedAt ?? now, sourceQuery
        );
        return `($${off + 1},$${off + 2},$${off + 3},$${off + 4},$${off + 5},$${off + 6},$${off + 7},$${off + 8},$${off + 9},$${off + 10},$${off + 11},$${off + 12},$${off + 13},$${off + 14})`;
      }).join(",");

      await client.query(
        `INSERT INTO twitter_tweets
           (tweet_id, author_id, handle, text, url, views, likes, retweets, replies, is_verified, posted_at, first_seen_at, updated_at, source_query)
         VALUES ${placeholders}
         ON CONFLICT (tweet_id) DO UPDATE SET
           author_id = COALESCE(EXCLUDED.author_id, twitter_tweets.author_id),
           views    = COALESCE(EXCLUDED.views,    twitter_tweets.views),
           likes    = COALESCE(EXCLUDED.likes,    twitter_tweets.likes),
           retweets = COALESCE(EXCLUDED.retweets, twitter_tweets.retweets),
           replies  = COALESCE(EXCLUDED.replies,  twitter_tweets.replies),
           text = EXCLUDED.text, url = COALESCE(EXCLUDED.url,twitter_tweets.url),
           posted_at = COALESCE(EXCLUDED.posted_at,twitter_tweets.posted_at),
           source_query = COALESCE(EXCLUDED.source_query, twitter_tweets.source_query),
           updated_at = EXCLUDED.updated_at
         WHERE EXCLUDED.updated_at >= twitter_tweets.updated_at`,
        values
      );

      if (taskId !== undefined) {
        const inserted = await client.query(
          "INSERT INTO x_task_tweets(task_id,tweet_id) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING",
          [taskId, chunk.map(t=>t.id)],
        );
        newlyLinked = inserted.rowCount ?? 0;
      }
      const snapshots = chunk.map(t => ({ id:t.id, observed_at:new Date(t.observedAt ?? now).toISOString(), raw:t }));
      await client.query(`INSERT INTO twitter_tweet_observations(tweet_id,observed_at,raw)
        SELECT x.id,x.observed_at,x.raw FROM jsonb_to_recordset($1::jsonb) AS x(id text,observed_at timestamptz,raw jsonb)
        ON CONFLICT(tweet_id,observed_at) DO NOTHING`, [JSON.stringify(snapshots)]);

      for (const t of chunk) {
        await processTweetEntities({
          tweet_id: t.id,
          text: t.text ?? null,
        }, client);
      }
      const entities = chunk.flatMap(t => [
        ...(t.mentions??[]).map(value=>({id:t.id,kind:"mention_handle",value:value.toLowerCase()})),
        ...(t.hashtags??[]).map(value=>({id:t.id,kind:"hashtag",value:value.toLowerCase()})),
        ...(t.links??[]).map(value=>({id:t.id,kind:"url",value})),
        ...(t.relatedPostIds??[]).map(value=>({id:t.id,kind:"visible_post_reference",value})),
        ...(t.media??[]).filter(m=>m.url).map(m=>({id:t.id,kind:"media_"+m.type,value:m.url!})),
      ]);
      await client.query(`INSERT INTO twitter_entity_links(tweet_id,kind,value,first_seen_at,last_seen_at)
       SELECT DISTINCT x.id,x.kind,x.value,$2::timestamptz,$2::timestamptz FROM jsonb_to_recordset($1::jsonb) AS x(id text,kind text,value text)
       ON CONFLICT(tweet_id,kind,value) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at`,[JSON.stringify(entities),received]);
      const archive = Page.parse({ data: chunk.filter(t => t.postedAt !== null).map(t => ({
        id:t.id,...(t.authorId ? {author_id:t.authorId} : {}),text:t.text,created_at:new Date(t.postedAt!).toISOString(),author_handle:t.authorHandle,
        metrics_observed_at:new Date(t.observedAt ?? now).toISOString(),
        public_metrics:{ like_count:t.likes, impression_count:t.views, retweet_count:t.retweets,reply_count:t.replies },
        ...(fromHttp ? { http_observation: t } : { browser_observation: t }),
      })) });
      await storePage(client, sourceKey, archive, raw, received, null, { responseStatus: chunk.length === 0 ? "empty" : "nonempty" });

      if (mint) {
        const linkVals: unknown[] = [];
        const linkPh = chunk.map((t, j) => {
          const off = j * 4;
          linkVals.push(t.id, mint, t.authorHandle.toLowerCase(), now);
          return `($${off + 1},$${off + 2},$${off + 3},$${off + 4})`;
        }).join(",");
        await client.query(
          `INSERT INTO tweet_token_links (tweet_id, mint, handle, linked_at)
           VALUES ${linkPh} ON CONFLICT (tweet_id, mint) DO NOTHING`,
          linkVals
        );
      }
      // Source tweet/archive writes and Intelligence Outbox share this transaction.
      // Unresolved author IDs are intentionally not re-identified from handles.
      for (const t of chunk) {
        const previous=previousById.get(t.id);
        if(previous && previous.text!==t.text){
          const authorId=t.authorId??previous.author_id;
          if(authorId){
            const sourceRevisionSha256=createHash("sha256")
              .update(JSON.stringify(["edited",t.text,t.postedAt??null]))
              .digest("hex");
            await emitXTokenLinksInvalidation(client,{
              tweetId:t.id,authorId,reason:"edited",sourceRevisionSha256,
              observedAt:new Date(),
              postedAt:t.postedAt===null?null:new Date(t.postedAt),
            });
          }
        }
        await emitXTweetOutbox(client,t,now);
      }
      return newlyLinked;
    };
    // Only count successful transaction results; tx() may retry rollbacks.
    newTaskLinks += options.client ? await writeChunk(options.client) : await tx(writeChunk);
  }
  return newTaskLinks;
}

export async function persistProfile(p: unknown, taskId?: number, collectorAccount?:string, lease?: PersistenceLease, options: { client?: PoolClient; transport?: "browser" | "http" } = {}): Promise<number> {
  const parsed = ProfileSchema.safeParse(p);
  if (!parsed.success) {
    log.warn("profile rejected by schema", { error: parsed.error.message });
    throw new Error("collector rejected malformed profile");
  }
  const d = parsed.data;
  const incomingEvidence = (p && typeof p === "object" && !Array.isArray(p))
    ? (p as { verificationEvidence?: unknown }).verificationEvidence : undefined;
  const verificationEvidence = options.transport !== "http" ? (d.isVerified ? "verified" : "unverified")
    : d.isVerified ? "verified"
    : incomingEvidence === "unverified" ? "unverified" : "unknown";
  const now = Date.now();
  const write = async (client: PoolClient): Promise<number> => {
  let newlyLinked = 0;
  await assertPersistenceLease(client, taskId, lease);
  const observedProfile = options.transport === "http" ? { ...d, verificationEvidence } : d;
  await recordRaw(client,'PROFILE',d.handle.toLowerCase(),observedProfile,new Date(now),collectorAccount??null);
  await client.query(
    `INSERT INTO twitter_profiles
       (handle, display_name, bio, followers, following, posts_count, is_verified, joined_at, avatar_url, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
     ON CONFLICT (handle) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, twitter_profiles.display_name),
       bio          = COALESCE(EXCLUDED.bio, twitter_profiles.bio),
       followers    = COALESCE(EXCLUDED.followers, twitter_profiles.followers),
       following    = COALESCE(EXCLUDED.following, twitter_profiles.following),
       posts_count  = COALESCE(EXCLUDED.posts_count, twitter_profiles.posts_count),
       -- Unknown HTTP verification never downgrades known data. An explicit
       -- GraphQL verification=false may revoke the previous true value.
       is_verified = CASE $11::text
         WHEN 'verified' THEN TRUE
         WHEN 'unverified' THEN FALSE
         ELSE twitter_profiles.is_verified END,
       joined_at    = COALESCE(EXCLUDED.joined_at, twitter_profiles.joined_at),
       avatar_url   = COALESCE(EXCLUDED.avatar_url, twitter_profiles.avatar_url),
       last_seen_at = EXCLUDED.last_seen_at`,
    [d.handle.toLowerCase(), d.displayName, d.bio, d.followers, d.following, d.postsCount,
     d.isVerified, d.joinedAt, d.avatarUrl, now, verificationEvidence]
  );
  if (taskId !== undefined) {
    const inserted = await client.query(
      "INSERT INTO x_task_profiles(task_id,handle) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [taskId,d.handle.toLowerCase()],
    );
    newlyLinked = inserted.rowCount ?? 0;
  }
  await client.query("INSERT INTO twitter_profile_observations(handle,observed_at,raw) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING", [d.handle.toLowerCase(),new Date(now),JSON.stringify(observedProfile)]);
  return newlyLinked;
  };
  return options.client ? write(options.client) : tx(write);
}
