import { q, q1 } from "./pg";

export interface HypeScore {
  mint: string; hype_score: string; velocity: string; sentiment: string;
  reach: string; kol_density: string; coord_penalty: string;
  prev_score: string | null; delta_1h: string | null; computed_at: string;
}

export async function rebuildHypeScores(): Promise<number> {
  const r = await q<{ rebuild_hype_scores: number }>(`SELECT rebuild_hype_scores()`);
  return r[0]?.rebuild_hype_scores ?? 0;
}

export async function getHypeScore(mint: string): Promise<HypeScore | null> {
  return q1<HypeScore>(`SELECT * FROM mint_hype_scores WHERE mint = $1`, [mint]);
}

export async function getTopHype(limit = 30, minScore = 40): Promise<HypeScore[]> {
  return q<HypeScore>(
    `SELECT * FROM mint_hype_scores WHERE hype_score >= $1 ORDER BY hype_score DESC LIMIT $2`,
    [minScore, limit]
  );
}

export async function getHypeRisers(limit = 30): Promise<HypeScore[]> {
  return q<HypeScore>(
    `SELECT * FROM mint_hype_scores WHERE delta_1h > 5 ORDER BY delta_1h DESC LIMIT $1`, [limit]
  );
}

export async function getHypeFallers(limit = 30): Promise<HypeScore[]> {
  return q<HypeScore>(
    `SELECT * FROM mint_hype_scores WHERE delta_1h < -5 ORDER BY delta_1h ASC LIMIT $1`, [limit]
  );
}

export interface EarlySignal {
  mint: string; hype_score: string | null; delta_1h: string | null;
  last_30m: string; prev_90m: string | null; velocity_x: string | null;
  sent_now: string | null; sent_base: string | null; sent_delta: string | null;
  kol_last_30m: string; signal_strength: number;
}

export async function getEarlySignals(limit = 30, minStrength = 30): Promise<EarlySignal[]> {
  return q<EarlySignal>(
    `SELECT * FROM v_early_signals WHERE signal_strength >= $1 LIMIT $2`,
    [minStrength, limit]
  );
}

export async function rebuildMintSimilarity(): Promise<number> {
  const r = await q<{ rebuild_mint_similarity: number }>(`SELECT rebuild_mint_similarity()`);
  return r[0]?.rebuild_mint_similarity ?? 0;
}

export interface SimilarMint {
  other_mint: string; shared_authors: string; jaccard: string; final_score: string;
}

export async function getSimilarMints(mint: string, limit = 20): Promise<SimilarMint[]> {
  return q<SimilarMint>(
    `SELECT mint_b AS other_mint, shared_authors::text, jaccard::text,
            (jaccard * 100)::text AS final_score
     FROM mint_similarity WHERE mint_a = $1 ORDER BY jaccard DESC LIMIT $2`,
    [mint, limit]
  );
}

export async function rebuildLeadStats(): Promise<number> {
  const r = await q<{ rebuild_author_lead_stats: number }>(`SELECT rebuild_author_lead_stats()`);
  return r[0]?.rebuild_author_lead_stats ?? 0;
}

export interface LeadAuthor {
  handle: string; lead_ratio: string; mint_starts: number; mint_participated: number;
  median_lead_minutes: string; reputation_score: string | null;
  is_verified: boolean | null; followers: string | null;
}

export async function getLeadAuthors(limit = 50): Promise<LeadAuthor[]> {
  return q<LeadAuthor>(`SELECT * FROM v_lead_authors LIMIT $1`, [limit]);
}

export async function getAuthorLeadStats(handle: string) {
  return q1(`SELECT * FROM author_lead_stats WHERE handle = $1`, [handle.toLowerCase()]);
}

export async function getAuthorRetention(limit = 500) {
  return q(`SELECT * FROM v_author_retention LIMIT $1`, [limit]);
}

export interface WeightedSentiment {
  mint: string; tweets: number; weighted_sentiment: string;
  raw_sentiment: string; follower_weighted_sentiment: string;
}

export async function getWeightedSentiment(mint: string): Promise<WeightedSentiment | null> {
  return q1<WeightedSentiment>(`SELECT * FROM v_weighted_sentiment WHERE mint = $1`, [mint]);
}

export async function getTopWeightedSentiment(limit = 30) {
  return q<WeightedSentiment>(
    `SELECT * FROM v_weighted_sentiment WHERE tweets >= 10
     ORDER BY weighted_sentiment DESC LIMIT $1`, [limit]
  );
}

export async function rebuildPageRank(damping = 0.85, iterations = 20, minWeight = 2): Promise<number> {
  const r = await q<{ rebuild_pagerank: number }>(
    `SELECT rebuild_pagerank($1, $2, $3)`, [damping, iterations, minWeight]
  );
  return r[0]?.rebuild_pagerank ?? 0;
}

export interface PageRankRow {
  handle: string; pagerank: string; degree_in: number; degree_out: number;
}

export async function getTopPageRank(limit = 50): Promise<PageRankRow[]> {
  return q<PageRankRow>(
    `SELECT handle, pagerank::text, degree_in, degree_out
     FROM author_pagerank ORDER BY pagerank DESC LIMIT $1`, [limit]
  );
}

export async function getAuthorPageRank(handle: string): Promise<PageRankRow | null> {
  return q1<PageRankRow>(
    `SELECT handle, pagerank::text, degree_in, degree_out
     FROM author_pagerank WHERE handle = $1`, [handle.toLowerCase()]
  );
}

export interface BacktestRun {
  id: number; name: string; params: unknown; metric_basis: string; notes: string | null;
  started_at: string; finished_at: string | null;
  signals_count: number; avg_views_change_pct: string; median_views_change_pct: string;
  positive_attention_rate: string; min_views_change_pct: string;
}

export async function runBacktest(params: {
  name: string; threshold: number; holdHours: number; fromMs?: number;
}): Promise<number> {
  const r = await q<{ backtest_hype_threshold: string }>(
    `SELECT backtest_hype_threshold($1, $2, $3, $4)`,
    [params.name, params.threshold, params.holdHours, params.fromMs ?? null]
  );
  return Number(r[0]?.backtest_hype_threshold ?? 0);
}

export async function listBacktests(limit = 20): Promise<BacktestRun[]> {
  return q<BacktestRun>(
    `SELECT id, name, params, metric_basis, notes, started_at::text, finished_at::text,
            signals_count, avg_views_change_pct::text, median_views_change_pct::text,
            positive_attention_rate::text, min_views_change_pct::text
     FROM backtest_runs ORDER BY started_at DESC LIMIT $1`, [limit]
  );
}

export async function getBacktestTrades(runId: number, limit = 100) {
  return q(
    `SELECT mint, signal_at::text, entry_score::text, entry_views,
            exit_views, views_change_pct::text, hold_hours, metadata
     FROM backtest_trades WHERE run_id = $1 ORDER BY signal_at DESC LIMIT $2`,
    [runId, limit]
  );
}

export async function rebuildUltraScores(): Promise<number> {
  const r = await q<{ rebuild_ultra_scores: number }>(`SELECT rebuild_ultra_scores()`);
  return r[0]?.rebuild_ultra_scores ?? 0;
}

