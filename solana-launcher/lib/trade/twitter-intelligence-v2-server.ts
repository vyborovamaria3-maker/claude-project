import "server-only";

import { getDb } from "@/lib/trade/db";
import {
  buildProvenanceFeature,
  rebuildProvenanceSnapshot,
  type AnalysisSnapshot,
} from "@/lib/trade/intelligence-agent-provenance";
import {
  buildTwitterIntelligenceV2FromSnapshot,
  twitterIntelligenceV2FeatureRows,
  type TwitterHistoryRowV2,
  type TwitterIntelligenceV2,
} from "@/lib/trade/twitter-intelligence-v2";

const DAY = 86_400_000;
const MAX_ROWS = 20_000;

type DbRow = {
  tweet_id: string;
  author_handle: string;
  text: string;
  url: string | null;
  views: number;
  likes: number;
  retweets: number;
  replies: number;
  is_verified: number;
  is_suspicious: number;
  suspicion_score: number;
  posted_at: number | null;
  fetched_at: number;
  followers: number | null;
  posts_count: number | null;
  account_verified: number | null;
  first_seen_at: number | null;
  bot_score: number | null;
  is_bot: number | null;
};

function historyRows(mint: string, nowMs: number): TwitterHistoryRowV2[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT
       t.tweet_id, t.author_handle, t.text, t.url, t.views, t.likes, t.retweets, t.replies,
       t.is_verified, t.is_suspicious, t.suspicion_score, t.posted_at, t.fetched_at,
       a.followers, a.posts_count, a.is_verified AS account_verified, a.first_seen_at,
       a.bot_score, a.is_bot
     FROM twitter_token_tweets t
     LEFT JOIN twitter_accounts a ON lower(a.handle) = lower(t.author_handle)
     WHERE t.mint = ?
       AND COALESCE(t.posted_at, t.fetched_at) >= ?
     ORDER BY COALESCE(t.posted_at, t.fetched_at) DESC
     LIMIT ?`,
  ).all(mint, nowMs - 7 * DAY, MAX_ROWS) as DbRow[];
  return rows.map((row) => ({
    tweetId: String(row.tweet_id || ""),
    author: String(row.author_handle || ""),
    text: String(row.text || ""),
    url: row.url == null ? null : String(row.url),
    views: Number(row.views || 0),
    likes: Number(row.likes || 0),
    retweets: Number(row.retweets || 0),
    replies: Number(row.replies || 0),
    isVerified: Boolean(row.is_verified),
    isSuspicious: Boolean(row.is_suspicious),
    suspicionScore: Number(row.suspicion_score || 0),
    postedAt: row.posted_at == null ? null : Number(row.posted_at),
    fetchedAt: Number(row.fetched_at || 0),
    followers: row.followers == null ? null : Number(row.followers),
    postsCount: row.posts_count == null ? null : Number(row.posts_count),
    accountVerified: Boolean(row.account_verified),
    firstSeenAt: row.first_seen_at == null ? null : Number(row.first_seen_at),
    botScore: row.bot_score == null ? null : Number(row.bot_score),
    isBot: Boolean(row.is_bot),
  }));
}

function persist(intelligence: TwitterIntelligenceV2) {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS twitter_intelligence_v2_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    mint TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_twitter_intelligence_v2_mint
    ON twitter_intelligence_v2_snapshots(mint, created_at DESC);`);
  db.prepare(
    `INSERT INTO twitter_intelligence_v2_snapshots
      (snapshot_id, mint, schema_version, engine_version, created_at, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(snapshot_id) DO UPDATE SET
       payload_json = excluded.payload_json,
       created_at = excluded.created_at`,
  ).run(
    intelligence.snapshotId,
    intelligence.mint,
    intelligence.schemaVersion,
    intelligence.engineVersion,
    Date.parse(intelligence.createdAt),
    JSON.stringify(intelligence),
  );
}

export function buildTwitterIntelligenceV2ForSnapshot(snapshot: AnalysisSnapshot): {
  intelligence: TwitterIntelligenceV2;
  snapshot: AnalysisSnapshot;
} {
  const nowMs = Number.isFinite(Date.parse(snapshot.createdAt)) ? Date.parse(snapshot.createdAt) : Date.now();
  const rows = historyRows(snapshot.mint, nowMs);
  const intelligence = buildTwitterIntelligenceV2FromSnapshot({
    mint: snapshot.mint,
    rows,
    snapshotFeatures: snapshot.features,
    marketStale: Boolean(snapshot.rawSummary.marketStale),
    nowMs,
  });
  const additions = twitterIntelligenceV2FeatureRows(intelligence).map((row) => buildProvenanceFeature({
    ...row,
    group: "Twitter Intelligence V2",
    source: "derived",
    observedAt: intelligence.createdAt,
  }));
  const existing = new Set(snapshot.features.map((feature) => feature.key));
  const features = [...snapshot.features, ...additions.filter((feature) => !existing.has(feature.key))];
  const enriched = rebuildProvenanceSnapshot({ ...snapshot, features });
  try { persist(intelligence); } catch { /* analytics persistence must not block source AI */ }
  return { intelligence, snapshot: enriched };
}
