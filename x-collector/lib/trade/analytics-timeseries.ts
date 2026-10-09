import { q } from "./pg";

export async function rebuildMintMetrics1m(fromMs?: number): Promise<number> {
  const r = await q<{ rebuild_mint_metrics_1m: number }>(`SELECT rebuild_mint_metrics_1m($1)`, [fromMs ?? null]);
  return r[0]?.rebuild_mint_metrics_1m ?? 0;
}

export async function rebuildMintMetrics1h(fromMs?: number, toMs?: number): Promise<number> {
  const r = await q<{ rebuild_mint_metrics_1h: number }>(
    `SELECT rebuild_mint_metrics_1h($1, $2)`, [fromMs ?? null, toMs ?? null]
  );
  return r[0]?.rebuild_mint_metrics_1h ?? 0;
}

export async function rollupMint1d(fromMs?: number, toMs?: number): Promise<number> {
  const r = await q<{ rollup_mint_1d: number }>(`SELECT rollup_mint_1d($1, $2)`, [fromMs ?? null, toMs ?? null]);
  return r[0]?.rollup_mint_1d ?? 0;
}

export async function rollupMint1w(fromMs?: number, toMs?: number): Promise<number> {
  const r = await q<{ rollup_mint_1w: number }>(`SELECT rollup_mint_1w($1, $2)`, [fromMs ?? null, toMs ?? null]);
  return r[0]?.rollup_mint_1w ?? 0;
}

export async function rebuildAuthorMetrics1d(fromMs?: number, toMs?: number): Promise<number> {
  const r = await q<{ rebuild_author_metrics_1d: number }>(
    `SELECT rebuild_author_metrics_1d($1, $2)`, [fromMs ?? null, toMs ?? null]
  );
  return r[0]?.rebuild_author_metrics_1d ?? 0;
}

export async function getMintMetrics(
  mint: string, granularity: "1m" | "1h" | "1d" | "1w", fromMs?: number, limit = 1000
) {
  const tableByGranularity: Record<"1m" | "1h" | "1d" | "1w", string> = {
    "1m": "mint_metrics_1m",
    "1h": "mint_metrics_1h",
    "1d": "mint_metrics_1d",
    "1w": "mint_metrics_1w",
  };
  const table = tableByGranularity[granularity];
  if (!table) throw new Error("Unsupported metric granularity");
  const since = fromMs ?? Date.now() - 30 * 86400000;
  return q(
    `SELECT bucket, tweets, authors, views, likes, retweets, sentiment
     FROM ${table} WHERE mint = $1 AND bucket >= $2 ORDER BY bucket ASC LIMIT $3`,
    [mint, since, limit]
  );
}

export async function getMintAnomalies(mint?: string, limit = 100) {
  if (mint) return q(`SELECT * FROM v_mint_anomalies WHERE mint = $1 LIMIT $2`, [mint, limit]);
  return q(`SELECT * FROM v_mint_anomalies LIMIT $1`, [limit]);
}

export async function getAuthorMetrics(handle: string, days = 30) {
  const since = Date.now() - days * 86400000;
  return q(
    `SELECT bucket, tweets, views, likes, retweets, mints, sentiment
     FROM author_metrics_1d WHERE handle = $1 AND bucket >= $2 ORDER BY bucket ASC`,
    [handle.toLowerCase(), since]
  );
}

export async function getMintTrend(mint: string, hours = 24) {
  const since = Date.now() - hours * 3600000;
  return q(
    `SELECT bucket::text, tweets, authors, views::text, sentiment::text
     FROM mint_metrics_1h WHERE mint = $1 AND bucket >= $2 ORDER BY bucket ASC`,
    [mint, since]
  );
}

