import type pg from 'pg';
import { pool, withTransaction } from '@/server/db/pool.js';
import { env } from '@/server/config/env.js';
import { extractPostFeatures } from '@/server/xanalysis/features.js';
import type { XMention } from '@/server/xanalysis/xsearch.js';

type AccountIdMap = Map<string, string>;

function chunks<T>(rows: T[], size = env.INGEST_BATCH_SIZE): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < rows.length; index += size) output.push(rows.slice(index, index + size));
  return output;
}

async function upsertAccounts(client: pg.PoolClient, mentions: XMention[]): Promise<AccountIdMap> {
  const latest = new Map<string, XMention['author']>();
  for (const mention of mentions) latest.set(mention.author.handle.toLowerCase(), mention.author);
  const authors = [...latest.values()];
  const result = new Map<string, string>();
  for (const batch of chunks(authors)) {
    const handles = batch.map((author) => author.handle.toLowerCase());
    const { rows } = await client.query<{ id: string; handle: string }>(`
      INSERT INTO x_accounts(handle,display_name,profile_url,avatar_url,bio,followers,following,posts_count,verified,verified_type,joined_at,last_seen_at)
      SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::bigint[],$7::bigint[],$8::bigint[],$9::boolean[],$10::text[],$11::timestamptz[],$12::timestamptz[])
      ON CONFLICT (lower(handle)) DO UPDATE SET
        display_name=EXCLUDED.display_name,profile_url=EXCLUDED.profile_url,avatar_url=EXCLUDED.avatar_url,bio=EXCLUDED.bio,
        followers=EXCLUDED.followers,following=EXCLUDED.following,posts_count=EXCLUDED.posts_count,verified=EXCLUDED.verified,
        verified_type=EXCLUDED.verified_type,joined_at=COALESCE(EXCLUDED.joined_at,x_accounts.joined_at),last_seen_at=EXCLUDED.last_seen_at
      RETURNING id,handle`, [
      handles, batch.map((a) => a.name), batch.map((a) => a.profileUrl), batch.map((a) => a.avatarUrl), batch.map((a) => a.bio),
      batch.map((a) => a.followers), batch.map((a) => a.following), batch.map((a) => a.posts), batch.map((a) => a.isVerified),
      batch.map((a) => a.verifiedType), batch.map((a) => a.joinedAt), batch.map(() => new Date()),
    ]);
    for (const row of rows) result.set(row.handle.toLowerCase(), row.id);
  }
  return result;
}

async function insertPosts(client: pg.PoolClient, mentions: XMention[], accounts: AccountIdMap): Promise<number> {
  let inserted = 0;
  for (const batch of chunks(mentions)) {
    const valid = batch.filter((mention) => mention.createdAt && accounts.has(mention.author.handle.toLowerCase()));
    if (!valid.length) continue;
    const { rowCount } = await client.query(`
      INSERT INTO x_posts(id,created_at,author_id,text,url,likes,reposts,replies,quotes,views,raw)
      SELECT * FROM unnest($1::text[],$2::timestamptz[],$3::uuid[],$4::text[],$5::text[],$6::bigint[],$7::bigint[],$8::bigint[],$9::bigint[],$10::bigint[],$11::jsonb[])
      ON CONFLICT(id,created_at) DO UPDATE SET
        likes=EXCLUDED.likes,reposts=EXCLUDED.reposts,replies=EXCLUDED.replies,quotes=EXCLUDED.quotes,views=EXCLUDED.views,
        text=EXCLUDED.text,url=EXCLUDED.url,raw=EXCLUDED.raw`, [
      valid.map((m) => m.id), valid.map((m) => m.createdAt), valid.map((m) => accounts.get(m.author.handle.toLowerCase())),
      valid.map((m) => m.text), valid.map((m) => m.url), valid.map((m) => m.likes), valid.map((m) => m.retweets),
      valid.map((m) => m.replies), valid.map((m) => m.quotes), valid.map((m) => m.views), valid.map((m) => JSON.stringify(m)),
    ]);
    inserted += rowCount ?? 0;
  }
  return inserted;
}

async function insertFeatures(client: pg.PoolClient, mentions: XMention[]): Promise<number> {
  let inserted = 0;
  for (const batch of chunks(mentions)) {
    const valid = batch.filter((mention) => mention.createdAt);
    if (!valid.length) continue;
    const features = valid.map((mention) => extractPostFeatures(mention.text));
    const { rowCount } = await client.query(`
      INSERT INTO post_features(post_id,post_created_at,contracts,links,mentions,hashtags,tickers,words,normalized_text,text_fingerprint,feature_version)
      SELECT * FROM unnest($1::text[],$2::timestamptz[],$3::text[][],$4::text[][],$5::text[][],$6::text[][],$7::text[][],$8::text[][],$9::text[],$10::text[],$11::smallint[])
      ON CONFLICT(post_id,post_created_at) DO UPDATE SET
        contracts=EXCLUDED.contracts,links=EXCLUDED.links,mentions=EXCLUDED.mentions,hashtags=EXCLUDED.hashtags,tickers=EXCLUDED.tickers,
        words=EXCLUDED.words,normalized_text=EXCLUDED.normalized_text,text_fingerprint=EXCLUDED.text_fingerprint,
        feature_version=EXCLUDED.feature_version,extracted_at=now()`, [
      valid.map((m) => m.id), valid.map((m) => m.createdAt), features.map((f) => f.contracts), features.map((f) => f.links),
      features.map((f) => f.mentions), features.map((f) => f.hashtags), features.map((f) => f.tickers), features.map((f) => f.words),
      features.map((f) => f.normalizedText), features.map((f) => f.textFingerprint), valid.map(() => 1),
    ]);
    inserted += rowCount ?? 0;
  }
  return inserted;
}

export async function ingestMentions(mentions: XMention[]) {
  const startedAt = performance.now();
  const result = await withTransaction(async (client) => {
    const accounts = await upsertAccounts(client, mentions);
    const posts = await insertPosts(client, mentions, accounts);
    const features = await insertFeatures(client, mentions);
    return { accounts: accounts.size, posts, features };
  });
  return { ...result, elapsedMs: performance.now() - startedAt };
}

export async function refreshAccountFeatureCache(): Promise<void> {
  try {
    await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY account_feature_summary`);
  } catch {
    await pool.query(`REFRESH MATERIALIZED VIEW account_feature_summary`);
  }
}
