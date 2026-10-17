import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import { pool, migrate } from "../db.js";
import { ANALYSIS_VERSION } from "./extract.js";
import { OUTCOME_VERSION } from "./token-intelligence.js";

type DexPair = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { m5?: number; h1?: number };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
};

function numeric(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function fetchPairs(mint: string): Promise<DexPair[]> {
  const response = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(mint), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("DexScreener returned HTTP " + response.status);
  const body = await response.json() as { pairs?: DexPair[] | null };
  return Array.isArray(body.pairs) ? body.pairs : [];
}

/** Store observed market snapshots with explicit provider provenance; never fabricate historical prices. */
export async function refreshMarketSnapshots(limit = 100): Promise<{ checked: number; stored: number; unavailable: number; errors: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be 1..1000");
  const tokens = await pool.query<{ chain_id: string; mint: string }>(
    "SELECT t.chain_id,t.mint FROM tg_tokens t LEFT JOIN LATERAL (" +
    "SELECT max(observed_at) AS last_seen_at FROM tg_token_market_snapshots s " +
    "WHERE s.chain_id=t.chain_id AND s.mint=t.mint AND s.provider='dexscreener') latest ON TRUE " +
    "WHERE t.chain_id='solana-mainnet' ORDER BY latest.last_seen_at ASC NULLS FIRST,t.first_seen_at DESC LIMIT $1",
    [limit],
  );
  let stored = 0;
  let unavailable = 0;
  let errors = 0;
  for (const token of tokens.rows) {
    try {
      const pairs = await fetchPairs(token.mint);
      const pair = pairs
        .filter((candidate) => candidate.chainId?.toLowerCase() === "solana"
          && candidate.baseToken?.address === token.mint)
        .sort((a, b) => (numeric(b.liquidity?.usd) ?? 0) - (numeric(a.liquidity?.usd) ?? 0))[0];
      const observedAt = new Date();
      if (!pair) {
        await pool.query(
          "INSERT INTO tg_token_market_snapshots(chain_id,mint,observed_at,provider,data_quality,raw_payload) " +
          "VALUES($1,$2,$3,'dexscreener','unavailable',$4::jsonb)",
          [token.chain_id, token.mint, observedAt, JSON.stringify({ reason: "no_solana_base_pair_found" })],
        );
        unavailable++;
      } else {
        const price = numeric(pair.priceUsd);
        const liquidity = numeric(pair.liquidity?.usd);
        const volume5m = numeric(pair.volume?.m5);
        const volume1h = numeric(pair.volume?.h1);
        const marketCap = numeric(pair.marketCap) ?? numeric(pair.fdv);
        const quality = price !== null && liquidity !== null ? "observed" : "partial";
        const raw = {
          chainId: pair.chainId, dexId: pair.dexId, pairAddress: pair.pairAddress,
          baseToken: pair.baseToken, quoteToken: pair.quoteToken, pairCreatedAt: pair.pairCreatedAt,
        };
        await pool.query(
          "INSERT INTO tg_token_market_snapshots " +
          "(chain_id,mint,observed_at,price_usd,liquidity_usd,volume_5m,volume_1h,market_cap_estimate,provider,data_quality,raw_payload) " +
          "VALUES($1,$2,$3,$4,$5,$6,$7,$8,'dexscreener',$9,$10::jsonb)",
          [token.chain_id, token.mint, observedAt, price, liquidity, volume5m, volume1h, marketCap, quality, JSON.stringify(raw)],
        );
        stored++;
      }
    } catch (error) {
      errors++;
      console.warn("Market snapshot failed for mint", token.mint,
        error instanceof Error ? error.message : String(error));
    }
    await sleep(200);
  }
  return { checked: tokens.rows.length, stored, unavailable, errors };
}

type Mention = {
  source_id: string; message_id: string; chain_id: string; mint: string; mention_time: Date;
};

type Snapshot = { observed_at: Date; price_usd: string | null; liquidity_usd: string | null; provider: string };

function nearestSnapshot(snapshots: Snapshot[], target: Date, toleranceMs: number): Snapshot | null {
  let best: Snapshot | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const snapshot of snapshots) {
    if (snapshot.price_usd === null) continue;
    const delta = Math.abs(snapshot.observed_at.getTime() - target.getTime());
    if (delta <= toleranceMs && delta < bestDelta) { best = snapshot; bestDelta = delta; }
  }
  return best;
}

function returnsFromSeries(base: number, snapshots: Snapshot[]): { maxGain: number | null; maxDrawdown: number | null } {
  if (!(base > 0)) return { maxGain: null, maxDrawdown: null };
  let peak = base;
  let maxGain = 0;
  let maxDrawdown = 0;
  for (const snapshot of snapshots) {
    const price = numeric(snapshot.price_usd);
    if (price === null || price <= 0) continue;
    maxGain = Math.max(maxGain, (price / base - 1) * 100);
    peak = Math.max(peak, price);
    maxDrawdown = Math.max(maxDrawdown, (peak - price) / peak * 100);
  }
  return { maxGain, maxDrawdown };
}

/**
 * Outcomes are computed only from observed provider snapshots. If a snapshot did not exist
 * near the message time, the row is marked insufficient_data rather than backfilled with a guess.
 */
export async function refreshTokenOutcomes(limit = 500): Promise<{ processed: number; complete: number; insufficient: number; pending: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error("limit must be 1..5000");
  const mentions = await pool.query<Mention>(
    "SELECT tm.source_id::text,tm.message_id::text,tm.chain_id,tm.mint,min(tm.message_date) AS mention_time " +
    "FROM tg_token_mentions tm JOIN tg_messages m USING(source_id,message_id) " +
    "WHERE tm.analysis_version=$1 AND tm.orphaned=FALSE AND m.deleted_at IS NULL AND tm.message_date IS NOT NULL " +
    "AND NOT EXISTS (SELECT 1 FROM tg_token_outcomes o WHERE o.source_id=tm.source_id AND o.message_id=tm.message_id " +
    "AND o.chain_id=tm.chain_id AND o.mint=tm.mint AND o.analysis_version=$1 AND o.model_version=$2 " +
    "AND o.outcome_status IN ('complete','risk_confirmed')) " +
    "GROUP BY tm.source_id,tm.message_id,tm.chain_id,tm.mint ORDER BY min(tm.message_date) ASC LIMIT $3",
    [ANALYSIS_VERSION, OUTCOME_VERSION, limit],
  );
  let complete = 0;
  let insufficient = 0;
  let pending = 0;

  for (const mention of mentions.rows) {
    const mentionTime = new Date(mention.mention_time);
    const now = new Date();
    const snapshotsResult = await pool.query<Snapshot>(
      "SELECT observed_at,price_usd::text,liquidity_usd::text,provider FROM tg_token_market_snapshots " +
      "WHERE chain_id=$1 AND mint=$2 AND provider='dexscreener' " +
      "AND observed_at BETWEEN $3::timestamptz-interval '5 minutes' AND $3::timestamptz+interval '7 days' " +
      "ORDER BY observed_at",
      [mention.chain_id, mention.mint, mentionTime],
    );
    const snapshots = snapshotsResult.rows;
    const base = nearestSnapshot(snapshots, mentionTime, 5 * 60 * 1000);
    const target = (ms: number, tolerance: number) => nearestSnapshot(snapshots, new Date(mentionTime.getTime() + ms), tolerance);
    const p5m = target(5 * 60 * 1000, 3 * 60 * 1000);
    const p1h = target(60 * 60 * 1000, 10 * 60 * 1000);
    const p6h = target(6 * 60 * 60 * 1000, 30 * 60 * 1000);
    const p24h = target(24 * 60 * 60 * 1000, 60 * 60 * 1000);
    const p7d = target(7 * 24 * 60 * 60 * 1000, 6 * 60 * 60 * 1000);
    const ageMs = now.getTime() - mentionTime.getTime();
    let status: "pending" | "complete" | "insufficient_data";
    if (!base) status = ageMs < 10 * 60 * 1000 ? "pending" : "insufficient_data";
    else if (ageMs < 24 * 60 * 60 * 1000) status = "pending";
    else if (p24h) status = "complete";
    else status = "insufficient_data";
    const returns = base ? returnsFromSeries(Number(base.price_usd), snapshots.filter((s) => s.observed_at >= mentionTime)) :
      { maxGain: null, maxDrawdown: null };
    await pool.query(
      "INSERT INTO tg_token_outcomes(source_id,message_id,chain_id,mint,analysis_version,mention_time," +
      "price_at_mention,price_5m,price_1h,price_6h,price_24h,price_7d,max_gain_pct,max_drawdown_pct," +
      "liquidity_at_mention,outcome_status,market_provider,calculated_at,model_version) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),$18) " +
      "ON CONFLICT(source_id,message_id,chain_id,mint,analysis_version,model_version) DO UPDATE SET " +
      "price_at_mention=EXCLUDED.price_at_mention,price_5m=EXCLUDED.price_5m,price_1h=EXCLUDED.price_1h," +
      "price_6h=EXCLUDED.price_6h,price_24h=EXCLUDED.price_24h,price_7d=EXCLUDED.price_7d," +
      "max_gain_pct=EXCLUDED.max_gain_pct,max_drawdown_pct=EXCLUDED.max_drawdown_pct," +
      "liquidity_at_mention=EXCLUDED.liquidity_at_mention,outcome_status=EXCLUDED.outcome_status," +
      "market_provider=EXCLUDED.market_provider,calculated_at=now()",
      [mention.source_id, mention.message_id, mention.chain_id, mention.mint, ANALYSIS_VERSION, mentionTime,
        base?.price_usd ?? null, p5m?.price_usd ?? null, p1h?.price_usd ?? null, p6h?.price_usd ?? null,
        p24h?.price_usd ?? null, p7d?.price_usd ?? null, returns.maxGain, returns.maxDrawdown,
        base?.liquidity_usd ?? null, status, base?.provider ?? "dexscreener", OUTCOME_VERSION],
    );
    if (status === "complete") complete++;
    else if (status === "insufficient_data") insufficient++;
    else pending++;
  }
  return { processed: mentions.rows.length, complete, insufficient, pending };
}

async function main(): Promise<void> {
  await migrate();
  const action = process.argv[2] ?? "snapshots";
  const limitRaw = process.argv.find((arg) => arg.startsWith("--limit="))?.slice("--limit=".length);
  const limit = limitRaw === undefined ? 100 : Number(limitRaw);
  if (action === "snapshots") {
    console.log(JSON.stringify(await refreshMarketSnapshots(limit)));
  } else if (action === "outcomes") {
    console.log(JSON.stringify(await refreshTokenOutcomes(Math.min(limit, 5000))));
  } else {
    throw new Error("Usage: npm run market:refresh -- snapshots|outcomes [--limit=100]");
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\\\", "/"))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }).finally(() => pool.end());
}
