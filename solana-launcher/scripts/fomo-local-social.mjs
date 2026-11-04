import { Pool } from 'pg';

export const LOCAL_SOCIAL_CAPTURE_POLICY = Object.freeze({
  source: 'local_postgresql_exact_mint_v1',
  hours: 24,
  xLimit: 40,
  tgLimit: 200,
  coverage: 'partial',
  riskClassification: 'unavailable_neutral_prior_50',
  suspiciousExclusion: 'none_no_verified_classifier',
});
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HOUR = 3_600_000;
const base58Boundary = (mint) => `(^|[^1-9A-HJ-NP-Za-km-z])${mint}([^1-9A-HJ-NP-Za-km-z]|$)`;
const number = (value) => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
const nullableNumber = (value) => value == null ? null : number(value);
const sum = (rows, key) => rows.reduce((total, row) => total + number(row[key]), 0);
const ms = (value) => typeof value === 'number' ? value : value instanceof Date ? value.getTime() : Date.parse(value);

function validArguments(mint, asOf) {
  if (!MINT.test(mint)) throw new TypeError('invalid_mint');
  if (!Number.isSafeInteger(asOf) || asOf <= 0 || asOf > Date.now()) throw new TypeError('invalid_as_of');
}

async function readOnly(pool, source, callback) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    const value = await callback(client);
    await client.query('COMMIT');
    return value;
  } catch {
    if (client) await client.query('ROLLBACK').catch(() => {});
    // PostgreSQL errors/connection strings may contain credentials. Never expose them.
    throw new Error(`${source}_source_unavailable`);
  } finally {
    client?.release();
  }
}

export function normalizeLocalSocialRows({ mint, asOf, xRows, xMatched, tgRows, tgMatched }) {
  validArguments(mint, asOf);
  const exactMint = new RegExp(base58Boundary(mint));
  const earliest = asOf - 24 * HOUR;
  const x = xRows.filter((row) => ms(Number(row.posted_at)) >= earliest
    && ms(Number(row.posted_at)) <= asOf && Number(row.updated_at) <= asOf
    && Number(row.first_seen_at) <= asOf && exactMint.test(String(row.text || '')))
    .sort((a, b) => Number(b.posted_at) - Number(a.posted_at)).slice(0, 40);
  const tg = tgRows.filter((row) => ms(row.posted_at) >= earliest && ms(row.posted_at) <= asOf
    && ms(row.collected_at) <= asOf && (!row.edited_at || ms(row.edited_at) <= asOf)
    && !row.deleted_at && exactMint.test(String(row.text || '')))
    .sort((a, b) => ms(a.posted_at) - ms(b.posted_at)).slice(-200);
  const authors = new Map();
  for (const row of x) {
    const handle = String(row.handle || '').toLowerCase();
    const author = authors.get(handle) || {
      handle, tweets: 0, totalEngagement: 0, isBot: false,
      followers: nullableNumber(row.followers), postsCount: nullableNumber(row.posts_count),
      isVerified: row.is_verified === true,
    };
    author.tweets++;
    author.totalEngagement += number(row.likes) + number(row.retweets) + number(row.replies);
    authors.set(handle, author);
  }
  const totalViews = sum(x, 'views');
  const totalEngagement = sum(x, 'likes') + sum(x, 'retweets') + sum(x, 'replies');
  const topTweets = x.map((row) => ({
    id: String(row.tweet_id), text: String(row.text || ''), author: String(row.handle || ''),
    url: row.url || null, likes: number(row.likes), retweets: number(row.retweets),
    replies: number(row.replies), views: number(row.views), timestamp: Number(row.posted_at),
    isVerified: row.is_verified === true, isSuspicious: false,
  }));
  const timeline = tg.map((row, index) => {
    const observed = ms(row.engagement_observed_at) <= asOf;
    const metrics = observed ? {
      views: number(row.views), forwards: number(row.forwards), replies: number(row.replies),
    } : {};
    return {
      rank: index + 1, platform: 'telegram', event_type: 'token_mention',
      source_handle: String(row.identifier || ''), source_name: row.title || null,
      source_url: /^@?[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(row.identifier || '')
        ? `https://t.me/${row.identifier.replace(/^@/, '')}/${row.message_id}` : null,
      text: String(row.text || ''), occurred_at: new Date(ms(row.posted_at)).toISOString(), metrics,
      source_id: String(row.source_id), message_id: String(row.message_id),
    };
  });
  const xMatchedCount = Math.max(x.length, number(xMatched));
  const tgMatchedCount = Math.max(tg.length, number(tgMatched));
  return {
    x: {
      symbol: '', totalTweets: x.length, totalViews, totalLikes: sum(x, 'likes'),
      totalRetweets: sum(x, 'retweets'), uniqueMentioners: authors.size,
      // Absence of stored bot labels is not evidence of clean activity. The
      // separate local source version uses a neutral prior and reports it.
      botRiskScore: 50, riskClassificationAvailable: false, anomalyCount: 0, topTweets, shillers: [...authors.values()],
      lastUpdated: asOf, performance: { cached: false }, collectionTruncated: xMatchedCount > x.length,
      meta: { matchedBeforeLimit: xMatchedCount, returned: x.length, truncated: xMatchedCount > x.length,
        queryMode: 'latest', suspiciousExcluded: false, verifiedOnly: false,
        source: LOCAL_SOCIAL_CAPTURE_POLICY.source,
        riskClassification: LOCAL_SOCIAL_CAPTURE_POLICY.riskClassification },
      aggregated: { totalEngagement, engagementRate: totalViews ? totalEngagement / totalViews : 0,
        verifiedAuthors: [...authors.values()].filter((a) => a.isVerified).length,
        botRatio: 0.5 },
    },
    tg: {
      mint_address: mint, mentions: timeline.length, platforms: { telegram: timeline.length },
      origin: timeline[0] || null, timeline,
      meta: { matchedBeforeLimit: tgMatchedCount, returned: timeline.length,
        truncated: tgMatchedCount > timeline.length, matchedPlatforms: { telegram: tgMatchedCount },
        uniqueSourcesBeforeLimit: new Set(timeline.map((row) => row.source_id)).size,
        explicitTelegramCallsBeforeLimit: 0,
        firstMatchedAt: timeline[0]?.occurred_at || null,
        lastMatchedAt: timeline.at(-1)?.occurred_at || null,
        source: LOCAL_SOCIAL_CAPTURE_POLICY.source, callClassification: 'unavailable' },
    },
    provenance: { ...LOCAL_SOCIAL_CAPTURE_POLICY, asOf, observedAt: asOf,
      xMatched: xMatchedCount, tgMatched: tgMatchedCount,
      xLatestMatchedAt: topTweets[0]?.timestamp || null,
      tgLatestMatchedAt: timeline.at(-1)?.occurred_at || null,
      xLatestInputObservationAt: x.length ? Math.max(...x.map((row) => Number(row.updated_at))) : null,
      tgLatestInputObservationAt: tg.length ? Math.max(...tg.map((row) => ms(row.collected_at))) : null },
  };
}

export function createLocalSocialSources({ xConnectionString, tgConnectionString, xPool, tgPool }) {
  if ((!xPool && !xConnectionString) || (!tgPool && !tgConnectionString)) {
    throw new Error('local_social_database_not_configured');
  }
  const xDatabase = xPool || new Pool({ connectionString: xConnectionString, max: 2,
    connectionTimeoutMillis: 4000, idleTimeoutMillis: 30000 });
  const tgDatabase = tgPool || new Pool({ connectionString: tgConnectionString, max: 2,
    connectionTimeoutMillis: 4000, idleTimeoutMillis: 30000 });
  let latestStatus = null;
  return {
    async capture(mint, { asOf = Date.now() } = {}) {
      validArguments(mint, asOf);
      const pattern = base58Boundary(mint);
      const [xResult, tgResult] = await Promise.all([
        readOnly(xDatabase, 'x', async (client) => {
          const result = await client.query(`WITH matched AS MATERIALIZED (
            SELECT t.* FROM twitter_tweets t WHERE t.posted_at >= $2 AND t.posted_at <= $3
              AND t.first_seen_at <= $3 AND t.updated_at <= $3 AND t.text ~ $1
          ) SELECT m.tweet_id,m.handle,m.text,m.url,m.views,m.likes,m.retweets,m.replies,
              m.is_verified,m.posted_at,m.first_seen_at,m.updated_at,
              p.followers,p.posts_count,(SELECT count(*) FROM matched)::integer AS matched_count
            FROM matched m LEFT JOIN twitter_profiles p ON p.handle=m.handle AND p.last_seen_at <= $3
            ORDER BY m.posted_at DESC,m.tweet_id DESC LIMIT 40`, [pattern, asOf - 24 * HOUR, asOf]);
          return result.rows;
        }),
        readOnly(tgDatabase, 'telegram', async (client) => {
          const result = await client.query(`WITH matched AS MATERIALIZED (
            SELECT m.* FROM tg_messages m WHERE m.posted_at >= $2::timestamptz AND m.posted_at <= $3::timestamptz
              AND m.collected_at <= $3::timestamptz AND m.deleted_at IS NULL
              AND (m.edited_at IS NULL OR m.edited_at <= $3::timestamptz) AND m.text ~ $1
          ) SELECT m.*,s.identifier,s.title,(SELECT count(*) FROM matched)::integer AS matched_count
            FROM matched m JOIN tg_sources s ON s.id=m.source_id
            ORDER BY m.posted_at DESC,m.source_id,m.message_id DESC LIMIT 200`,
          [pattern, new Date(asOf - 24 * HOUR).toISOString(), new Date(asOf).toISOString()]);
          return result.rows;
        }),
      ]);
      const payload = normalizeLocalSocialRows({ mint, asOf, xRows: xResult, tgRows: tgResult,
        xMatched: xResult[0]?.matched_count || 0, tgMatched: tgResult[0]?.matched_count || 0 });
      if (latestStatus) payload.provenance.corpusStatus = { ...latestStatus };
      return payload;
    },
    async watchlist({ limit = 12, asOf = Date.now() } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('invalid_watchlist_limit');
      validArguments('So11111111111111111111111111111111111111112', asOf);
      const [candidates, recent] = await Promise.all([
        readOnly(xDatabase, 'fomo_watchlist', async (client) => {
        const result = await client.query(`SELECT * FROM (
          SELECT DISTINCT ON (payload->'token'->>'address') payload,first_seen,last_seen
          FROM fomo_target_thoughts WHERE first_seen <= $1
            AND payload->'token'->>'address' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
            AND (payload->>'networkId'='1399811149' OR lower(payload->>'chain')='solana')
          ORDER BY payload->'token'->>'address',last_seen DESC
          ) tokens ORDER BY last_seen DESC LIMIT 1000`, [asOf]);
        // Keep both queries on the posted_at index. Combining max() with a
        // filtered count over all history forces a full corpus scan.
        const newest = await client.query(`SELECT posted_at AS latest_posted_at
          FROM twitter_tweets WHERE posted_at IS NOT NULL AND posted_at <= $1 AND first_seen_at <= $1
          ORDER BY posted_at DESC LIMIT 1`, [asOf]);
        const recentCount = await client.query(`SELECT count(*)::integer AS posts_24h
          FROM twitter_tweets WHERE posted_at >= $1 AND posted_at <= $2 AND first_seen_at <= $2`,
        [asOf - 24 * HOUR, asOf]);
        const seen = new Set();
        const mints = [];
        for (const row of result.rows) {
          const payload = row.payload || {};
          const mint = payload.token?.address;
          const rawTs = payload.ts;
          const time = typeof rawTs === 'number' ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : Date.parse(rawTs);
          if (!MINT.test(mint || '') || !Number.isFinite(time) || time > asOf || seen.has(mint)) continue;
          seen.add(mint);
          mints.push(mint);
        }
        return { mints, freshness: { latest_posted_at: newest.rows[0]?.latest_posted_at,
          posts_24h: recentCount.rows[0]?.posts_24h } };
      }),
        readOnly(tgDatabase, 'telegram_watchlist', async (client) => {
          const result = await client.query(`SELECT text,posted_at,collected_at FROM tg_messages
            WHERE deleted_at IS NULL AND posted_at >= $1::timestamptz AND posted_at <= $2::timestamptz
              AND collected_at <= $2::timestamptz AND (edited_at IS NULL OR edited_at <= $2::timestamptz)
            ORDER BY posted_at DESC,source_id,message_id DESC LIMIT 2000`,
          [new Date(asOf - 24 * HOUR).toISOString(), new Date(asOf).toISOString()]);
          return result.rows;
        }),
      ]);
      const known = new Set(candidates.mints);
      const matches = new Map();
      for (const row of recent) {
        const unique = new Set(String(row.text || '').match(/[1-9A-HJ-NP-Za-km-z]+/g) || []);
        for (const address of unique) if (known.has(address)) matches.set(address, (matches.get(address) || 0) + 1);
      }
      const ranked = [...matches].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([address]) => address);
      latestStatus = { observedAt: asOf,
        xLatestPostedAt: nullableNumber(candidates.freshness.latest_posted_at),
        xPosts24h: number(candidates.freshness.posts_24h),
        tgLatestPostedAt: recent[0] ? ms(recent[0].posted_at) : null,
        tgPosts24hSampled: recent.length, tgRecentSampleTruncated: recent.length === 2000,
        knownFomoTokens: candidates.mints.length, knownFomoTokensWithRecentTelegram: ranked.length };
      return [...new Set([...ranked, ...candidates.mints])].slice(0, limit);
    },
    status() { return latestStatus ? { ...latestStatus } : null; },
    async close() {
      await Promise.all([!xPool && xDatabase.end(), !tgPool && tgDatabase.end()]);
    },
  };
}
