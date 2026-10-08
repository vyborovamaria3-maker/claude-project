import { TweetSchema, ProfileSchema } from "./schemas";
import { tx } from "./pg";
import { log } from "./logger";
import { source, rawPage, storePage } from "../archive/store";
import { Page } from "../archive/model";
export async function persistTweets(mint: string | null, tweets: unknown[], sourceQuery: string | null = null) {
  const valid: Array<ReturnType<typeof TweetSchema.parse>> = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const raw of tweets) {
    const parsed = TweetSchema.safeParse(raw);
    if (parsed.success) { if (!seen.has(parsed.data.id)) { valid.push(parsed.data); seen.add(parsed.data.id); } }
    else rejected++;
  }
  if (rejected > 0) throw new Error(`collector rejected ${rejected} malformed tweets`);
  if (valid.length === 0) return;

  const now = Date.now();
  const BATCH = 200;

  for (let i = 0; i < valid.length; i += BATCH) {
    const chunk = valid.slice(i, i + BATCH);
    const received = new Date(now);
    const sourceKey = await source("X browser collector", "https://x.com", "X platform terms", "x", { transport: "visible DOM" });
    const raw = await rawPage({ tweets: chunk, sourceQuery, received_at: received.toISOString() });
    // Tweets y vínculos mint se insertan en una sola transacción: un fallo a mitad
    // no deja tweets sin su link (ni viceversa).
    await tx(async (client) => {
      const values: unknown[] = [];
      const placeholders = chunk.map((t, j) => {
        const off = j * 13;
        values.push(
          t.id, t.authorHandle.toLowerCase(), t.text, t.url,
          t.views, t.likes, t.retweets, t.replies,
          t.isVerified, t.postedAt, now, t.observedAt ?? now, sourceQuery
        );
        return `($${off + 1},$${off + 2},$${off + 3},$${off + 4},$${off + 5},$${off + 6},$${off + 7},$${off + 8},$${off + 9},$${off + 10},$${off + 11},$${off + 12},$${off + 13})`;
      }).join(",");

      await client.query(
        `INSERT INTO twitter_tweets
           (tweet_id, handle, text, url, views, likes, retweets, replies, is_verified, posted_at, first_seen_at, updated_at, source_query)
         VALUES ${placeholders}
         ON CONFLICT (tweet_id) DO UPDATE SET
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

      const snapshots = chunk.map(t => ({ id:t.id, observed_at:new Date(t.observedAt ?? now).toISOString(), raw:t }));
      await client.query(`INSERT INTO twitter_tweet_observations(tweet_id,observed_at,raw)
        SELECT x.id,x.observed_at,x.raw FROM jsonb_to_recordset($1::jsonb) AS x(id text,observed_at timestamptz,raw jsonb)
        ON CONFLICT(tweet_id,observed_at) DO NOTHING`, [JSON.stringify(snapshots)]);
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
        id:t.id,text:t.text,created_at:new Date(t.postedAt!).toISOString(),author_handle:t.authorHandle,
        metrics_observed_at:new Date(t.observedAt ?? now).toISOString(),
        public_metrics:{ like_count:t.likes, impression_count:t.views, retweet_count:t.retweets,reply_count:t.replies },
        browser_observation:t,
      })) });
      await storePage(client, sourceKey, archive, raw, received, null);

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
    });
  }
}

export async function persistProfile(p: unknown) {
  const parsed = ProfileSchema.safeParse(p);
  if (!parsed.success) {
    log.warn("profile rejected by schema", { error: parsed.error.message });
    throw new Error("collector rejected malformed profile");
  }
  const d = parsed.data;
  const now = Date.now();
  await tx(async client => {
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
       is_verified  = EXCLUDED.is_verified,
       joined_at    = COALESCE(EXCLUDED.joined_at, twitter_profiles.joined_at),
       avatar_url   = COALESCE(EXCLUDED.avatar_url, twitter_profiles.avatar_url),
       last_seen_at = EXCLUDED.last_seen_at`,
    [d.handle.toLowerCase(), d.displayName, d.bio, d.followers, d.following, d.postsCount,
     d.isVerified, d.joinedAt, d.avatarUrl, now]
  );
  await client.query("INSERT INTO twitter_profile_observations(handle,observed_at,raw) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING", [d.handle.toLowerCase(),new Date(now),JSON.stringify(d)]);
  });
}

