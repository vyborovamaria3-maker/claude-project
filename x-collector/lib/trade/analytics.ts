import { q, q1 } from "./pg";

export interface MintSummary {
  mint: string; total_tweets: number; unique_authors: number; verified_authors: number;
  total_views: string; total_likes: string; total_retweets: string;
  first_mention_at: number | null; last_mention_at: number | null; lifespan_ms: number | null;
}

export interface DailyFunnel {
  day: string; tweets: number; authors: number; views: string; likes: string;
  retweets: string; like_rate_pct: string; rt_rate_pct: string;
}

export interface MintBurst {
  mint: string; hour_start_ms: string; tweets: number; authors: number;
  prev_hour_tweets: number; growth_x: string | null; growth_6h_x: string | null;
}

export interface AuthorProfile {
  handle: string; total_tweets: number; mints_promoted: number;
  total_views: string; total_likes: string; total_retweets: string;
  avg_views_per_tweet: string; avg_likes_per_tweet: string;
  first_seen_at: number | null; last_seen_at: number | null;
  is_verified: boolean; engagement_pct: string;
}

export interface TopTweet {
  tweet_id: string; handle: string; text: string; url: string | null;
  views: string; likes: string; retweets: string; replies: string;
  posted_at: number | null; is_verified: boolean;
  engagement_score: string; mints: string[] | null;
}

export interface Shiller {
  handle: string; mints_promoted: number; total_tweets: number; total_views: string;
  avg_views_per_tweet: string; engagement_pct: string; is_verified: boolean;
  first_seen_at: number | null; last_seen_at: number | null;
}

export interface CoordinatedCluster {
  mint: string; text_hash: string; handles: string[]; author_count: number; sample_text: string;
}

export interface CoordinatedAccount {
  handle: string; involved_mints: number; coordinated_posts: number; mints: string[];
}

export interface AuthorGraphEdge {
  source: string; target: string; weight: number; shared_mints: string[];
}

export interface MintOverlap { mint_a: string; mint_b: string; shared_authors: number; }
export interface TrendingWord { word: string; occurrences: number; authors: number; }
export interface CashtagTrend { tag: string; mentions: number; authors: number; total_views: string; }
export interface WorkerEfficiency {
  id: string; status: string; tasks_done: string; tasks_failed: string;
  success_rate_pct: string; uptime_hours: string; last_heartbeat: string;
}
export interface AccountHealth {
  name: string; tier: string; status: string; total_requests: string; total_errors: string;
  error_rate_pct: string; consecutive_errors: number;
  weight_used_this_hour: number; weight_quota_per_hour: number;
  quota_used_pct: string; cooldown_sec: string;
}

export async function getMintSummary(mint: string): Promise<MintSummary | null> {
  return q1<MintSummary>(`SELECT * FROM v_mint_summary WHERE mint = $1`, [mint]);
}

export async function getMintDailyFunnel(mint: string, days = 30): Promise<DailyFunnel[]> {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return q<DailyFunnel>(
    `SELECT * FROM v_mint_daily_funnel WHERE mint = $1 AND day >= $2 ORDER BY day`,
    [mint, since]
  );
}

export async function getMintBursts(mint: string, limit = 20): Promise<MintBurst[]> {
  return q<MintBurst>(
    `SELECT * FROM v_mint_bursts WHERE mint = $1 ORDER BY hour_start_ms DESC LIMIT $2`,
    [mint, limit]
  );
}

export async function getMintTimeseries(
  mint: string, intervalMs = 3600000
): Promise<Array<{ bucket: string; tweets: number; authors: number; views: string; likes: string }>> {
  return q(`SELECT * FROM mint_timeseries($1, $2)`, [mint, intervalMs]);
}

export async function getTopTweetsForMint(mint: string, limit = 20): Promise<TopTweet[]> {
  return q<TopTweet>(
    `SELECT t.* FROM v_top_tweets t WHERE $1 = ANY(t.mints) ORDER BY t.engagement_score DESC LIMIT $2`,
    [mint, limit]
  );
}

export async function getAuthorProfile(handle: string): Promise<AuthorProfile | null> {
  return q1<AuthorProfile>(`SELECT * FROM v_author_profile WHERE handle = $1`, [handle.toLowerCase()]);
}

export async function getTopShillers(limit = 50): Promise<Shiller[]> {
  return q<Shiller>(`SELECT * FROM mv_shillers LIMIT $1`, [limit]);
}

export async function getRisingAuthors(limit = 30): Promise<Array<{
  handle: string; recent_tweets: number; recent_views: string;
  old_tweets: number; old_views: string; growth_x: string | null;
}>> {
  return q(`SELECT * FROM v_rising_authors ORDER BY recent_views DESC LIMIT $1`, [limit]);
}

export async function getTopAuthorsByViews(limit = 50): Promise<Array<{
  handle: string; mints: number; tweets: number; total_views: string;
  avg_views: string; is_verified: boolean;
}>> {
  return q(`SELECT * FROM top_authors_by_views($1)`, [limit]);
}

export async function getCoordinatedClusters(mint: string, minAuthors = 3): Promise<CoordinatedCluster[]> {
  return q<CoordinatedCluster>(
    `SELECT $1::text AS mint, text_hash, authors, author_cnt, sample FROM detect_coordination($1, $2)`,
    [mint, minAuthors]
  );
}

export async function getCoordinatedAccounts(limit = 50): Promise<CoordinatedAccount[]> {
  return q<CoordinatedAccount>(`SELECT * FROM mv_coordinated LIMIT $1`, [limit]);
}

export async function getAuthorGraph(minWeight = 2, limit = 200): Promise<AuthorGraphEdge[]> {
  return q<AuthorGraphEdge>(
    `SELECT source, target, weight, shared_mints FROM v_author_graph
     WHERE weight >= $1 ORDER BY weight DESC LIMIT $2`,
    [minWeight, limit]
  );
}

export async function getMintOverlap(minShared = 5, limit = 100): Promise<MintOverlap[]> {
  return q<MintOverlap>(
    `SELECT * FROM v_mint_overlap WHERE shared_authors >= $1 LIMIT $2`,
    [minShared, limit]
  );
}

export async function getTrendingWords(limit = 50): Promise<TrendingWord[]> {
  return q<TrendingWord>(`SELECT * FROM v_trending_words LIMIT $1`, [limit]);
}

export async function getCashtagTrends(limit = 50): Promise<CashtagTrend[]> {
  return q<CashtagTrend>(`SELECT * FROM v_cashtag_trends LIMIT $1`, [limit]);
}

export async function getWorkerEfficiency(): Promise<WorkerEfficiency[]> {
  return q<WorkerEfficiency>(`SELECT * FROM v_worker_efficiency`);
}

export async function getAccountHealth(): Promise<AccountHealth[]> {
  return q<AccountHealth>(`SELECT * FROM v_account_health`);
}

export async function getPipelineDaily(days = 30): Promise<Array<{
  day: string; tweets_collected: number; unique_authors: number; unique_queries: number;
}>> {
  return q(`SELECT * FROM v_pipeline_daily LIMIT $1`, [days]);
}

export async function getDailyDigest(day?: string): Promise<Array<{ metric: string; value: string }>> {
  return q(`SELECT * FROM daily_digest($1::date)`, [day ?? new Date().toISOString().slice(0, 10)]);
}

export interface MintFullReport {
  summary: MintSummary | null;
  dailyFunnel: DailyFunnel[];
  bursts: MintBurst[];
  topTweets: TopTweet[];
  topAuthors: Array<{ handle: string; total_views: string; tweets_count: number; is_verified: boolean }>;
  coordinated: CoordinatedCluster[];
  overlap: MintOverlap[];
}

export async function getMintFullReport(mint: string, days = 30): Promise<MintFullReport> {
  const [summary, dailyFunnel, bursts, topTweets, topAuthors, coordinated, overlap] = await Promise.all([
    getMintSummary(mint),
    getMintDailyFunnel(mint, days),
    getMintBursts(mint, 10),
    getTopTweetsForMint(mint, 20),
    q<{ handle: string; total_views: string; tweets_count: number; is_verified: boolean }>(
      `SELECT handle, total_views, tweets_count, is_verified FROM mv_author_token_stats
       WHERE mint = $1 ORDER BY total_views DESC LIMIT 30`, [mint]
    ),
    getCoordinatedClusters(mint, 3),
    q<MintOverlap>(
      `SELECT * FROM v_mint_overlap WHERE mint_a = $1 OR mint_b = $1
       ORDER BY shared_authors DESC LIMIT 20`, [mint]
    ),
  ]);
  return { summary, dailyFunnel, bursts, topTweets, topAuthors, coordinated, overlap };
}

export { toCSV } from "./csv";

export function toJSON<T>(rows: T[]): string { return JSON.stringify(rows, null, 2); }

