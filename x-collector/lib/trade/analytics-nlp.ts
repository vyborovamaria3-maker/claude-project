import { q, q1 } from "./pg";

export async function scoreSentimentForRecent(limit = 10000): Promise<number> {
  const r = await q<{ n: string }>(
    `INSERT INTO tweet_sentiment (tweet_id, score, label, confidence, model, scored_at)
     SELECT t.tweet_id, s.score,
       CASE WHEN s.score > 0.15 THEN 'bullish' WHEN s.score < -0.15 THEN 'bearish' ELSE 'neutral' END,
       LEAST(ABS(s.score) + 0.3, 1.0), 'lexicon-v1',
       (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
     FROM twitter_tweets t
     CROSS JOIN LATERAL (SELECT score_sentiment(t.text) AS score) s
     WHERE NOT EXISTS (SELECT 1 FROM tweet_sentiment ts WHERE ts.tweet_id = t.tweet_id)
     ORDER BY t.first_seen_at DESC LIMIT $1
     ON CONFLICT (tweet_id) DO NOTHING RETURNING 1 AS n`,
    [limit]
  );
  return r.length;
}

export async function scoreToxicityForRecent(limit = 10000): Promise<number> {
  const r = await q<{ n: string }>(
    `INSERT INTO tweet_toxicity (tweet_id, toxicity, spam_score, scam_score, scored_at)
     SELECT t.tweet_id, s.toxicity, s.spam_score, s.scam_score,
       (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
     FROM twitter_tweets t
     CROSS JOIN LATERAL scan_tweet_toxicity(t.text) s
     WHERE NOT EXISTS (SELECT 1 FROM tweet_toxicity tx WHERE tx.tweet_id = t.tweet_id)
     ORDER BY t.first_seen_at DESC LIMIT $1
     ON CONFLICT (tweet_id) DO NOTHING RETURNING 1 AS n`,
    [limit]
  );
  return r.length;
}

export async function extractEntitiesForRecent(limit = 5000): Promise<number> {
  const r = await q<{ n: string }>(
    `INSERT INTO tweet_entities (tweet_id, entity_type, value, extracted_at)
     WITH base AS (
       SELECT tweet_id, text FROM twitter_tweets t
       WHERE NOT EXISTS (SELECT 1 FROM tweet_entities e WHERE e.tweet_id = t.tweet_id)
       ORDER BY t.first_seen_at DESC LIMIT $1
     ),
     all_e AS (
       SELECT tweet_id, 'wallet' AS t, unnest(regexp_matches(text, '\\y[1-9A-HJ-NP-Za-km-z]{32,44}\\y', 'g')) AS v FROM base
       UNION ALL
       SELECT tweet_id, 'cashtag', unnest(regexp_matches(text, '\\$([A-Z]{2,10})', 'g')) FROM base
       UNION ALL
       SELECT tweet_id, 'handle', unnest(regexp_matches(text, '@(\\w{1,15})', 'g')) FROM base
       UNION ALL
       SELECT tweet_id, 'hashtag', unnest(regexp_matches(text, '#(\\w{1,30})', 'g')) FROM base
       UNION ALL
       SELECT tweet_id, 'url', unnest(regexp_matches(text, 'https?://[^\\s]+', 'g')) FROM base
     )
     SELECT tweet_id, t, v, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
     FROM all_e WHERE length(v) > 0 RETURNING 1 AS n`,
    [limit]
  );
  return r.length;
}

export interface SentimentSummary {
  tweets_scored: number; avg_sentiment: string; bullish: number;
  bearish: number; spam_count: number;
}

export async function getSentimentByMint(mint: string): Promise<SentimentSummary | null> {
  const r = await q<SentimentSummary>(
    `SELECT COUNT(*)::INT AS tweets_scored, ROUND(AVG(s.score), 4) AS avg_sentiment,
       COUNT(*) FILTER (WHERE s.label='bullish')::INT AS bullish,
       COUNT(*) FILTER (WHERE s.label='bearish')::INT AS bearish,
       COUNT(*) FILTER (WHERE tx.spam_score > 0.7)::INT AS spam_count
     FROM tweet_token_links l
     JOIN tweet_sentiment s ON s.tweet_id = l.tweet_id
     LEFT JOIN tweet_toxicity tx ON tx.tweet_id = l.tweet_id
     WHERE l.mint = $1`, [mint]
  );
  return r[0] ?? null;
}

export async function getSentimentByAuthor(handle: string) {
  return q1(`SELECT * FROM mv_author_sentiment WHERE handle = $1`, [handle.toLowerCase()]);
}

export async function getMintSentimentDaily(mint: string, days = 30) {
  return q(
    `SELECT * FROM mv_mint_sentiment_daily
     WHERE mint = $1 AND day >= (CURRENT_DATE - ($2 || ' days')::INTERVAL)::date
     ORDER BY day`, [mint, days]
  );
}

