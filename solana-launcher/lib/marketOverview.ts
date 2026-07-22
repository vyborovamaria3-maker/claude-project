import {
  getMarketOverviewAggregate,
  getMarketEventSeries,
  getNewWalletSeries,
  getMarketCollectorStatus,
} from "./trade/db";
import { getTwitterSocialStats, type TwitterSocialStats } from "./twitterSocialStats";

export interface TimeSeriesPoint {
  timestamp: number;
  value: number;
}

export interface MarketOverviewData {
  launched: {
    total: number;
    trend: TimeSeriesPoint[];
  };
  migrated: {
    total: number;
    share: number;
    trend: TimeSeriesPoint[];
  };
  volume: {
    totalSol: number;
    beforeMigration: number;
    afterMigration: number;
    trend: TimeSeriesPoint[];
  };
  traders: {
    total: number;
    beforeMigration: number;
    afterMigration: number;
    trend: TimeSeriesPoint[];
  };
  newWallets: {
    total: number;
    trend: TimeSeriesPoint[];
  };
  botFees: {
    totalSol: number;
    beforeMigration: number;
    afterMigration: number;
    trend: TimeSeriesPoint[];
  };
  marketCap: {
    avgUsd: number;
    avgSol: number;
    trend: TimeSeriesPoint[];
  };
  activeTokens: {
    total: number;
    trend: TimeSeriesPoint[];
  };
  twitterSocial: TwitterSocialStats;
  meta: {
    source: "sqlite" | "bitquery" | "fallback";
    fallback: boolean;
    reason: string | null;
    updatedAt: number;
    solPriceUsd: number;
    sampledMarketCaps: number;
    bitqueryConfigured: boolean;
    collectorConfigured: boolean;
  };
}

export type MarketOverviewTimeframe = "1h" | "6h" | "24h" | "7d" | "30d" | "90d" | "180d" | "365d" | "all";

type IntervalConfig = {
  count: number;
  unit: "minutes" | "hours" | "days";
  ms: number;
};

type InstructionRow = {
  Block?: { Time?: string | null };
  count?: string | number | null;
};

type TradeAggregateRow = {
  Block?: { Time?: string | null };
  volumeUsd?: string | number | null;
  traders?: string | number | null;
  activeTokens?: string | number | null;
};

type MarketCapRow = {
  Trade?: { Currency?: { MintAddress?: string | null } };
  Supply?: { MarketCap?: string | number | null };
};

type BitqueryResponse = {
  data?: {
    Solana?: {
      launchedSeries?: InstructionRow[];
      launchedTotal?: InstructionRow[];
      migratedSeries?: InstructionRow[];
      migratedTotal?: InstructionRow[];
      combinedTradeSeries?: TradeAggregateRow[];
      combinedTradeTotals?: TradeAggregateRow[];
      preTradeTotals?: TradeAggregateRow[];
      postTradeTotals?: TradeAggregateRow[];
      preTradeSeries?: TradeAggregateRow[];
      postTradeSeries?: TradeAggregateRow[];
      marketCapSample?: MarketCapRow[];
    };
  };
  errors?: Array<{ message?: string }>;
};

const BITQUERY_KEY = process.env.BITQUERY_API_KEY || "";
const BITQUERY_URL = "https://streaming.bitquery.io/eap";
const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_SWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const cache = new Map<string, { data: MarketOverviewData; timestamp: number }>();

function emptyTwitterSocialStats(): TwitterSocialStats {
  return {
    totalAccounts: 0,
    totalCommunities: 0,
    accountsWithContracts: 0,
    memecoinAccounts: 0,
    pumpfunMentions: 0,
    contractsFound: 0,
    createdToday: 0,
    created7d: 0,
    created30d: 0,
    created365d: 0,
    discoveredToday: 0,
    discovered7d: 0,
    discoveryVelocity7d: 0,
    topContracts: [],
    recentDiscoveries: [],
    series: [],
  };
}

function getTimeframeMs(tf: MarketOverviewTimeframe): number {
  const map: Record<MarketOverviewTimeframe, number> = {
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    "90d": 90 * 24 * 60 * 60 * 1000,
    "180d": 180 * 24 * 60 * 60 * 1000,
    "365d": 365 * 24 * 60 * 60 * 1000,
    "all": 365 * 24 * 60 * 60 * 1000,
  };
  return map[tf];
}

function getInterval(tf: MarketOverviewTimeframe): IntervalConfig {
  const map: Record<MarketOverviewTimeframe, IntervalConfig> = {
    "1h": { count: 5, unit: "minutes", ms: 5 * 60 * 1000 },
    "6h": { count: 15, unit: "minutes", ms: 15 * 60 * 1000 },
    "24h": { count: 1, unit: "hours", ms: 60 * 60 * 1000 },
    "7d": { count: 4, unit: "hours", ms: 4 * 60 * 60 * 1000 },
    "30d": { count: 1, unit: "days", ms: 24 * 60 * 60 * 1000 },
    "90d": { count: 1, unit: "days", ms: 24 * 60 * 60 * 1000 },
    "180d": { count: 1, unit: "days", ms: 24 * 60 * 60 * 1000 },
    "365d": { count: 1, unit: "days", ms: 24 * 60 * 60 * 1000 },
    "all": { count: 1, unit: "days", ms: 24 * 60 * 60 * 1000 },
  };
  return map[tf];
}

function getCacheTtl(tf: MarketOverviewTimeframe) {
  if (tf === "1h" || tf === "6h" || tf === "24h") return 60_000;
  if (tf === "7d" || tf === "30d") return 5 * 60_000;
  return 15 * 60_000;
}

function seededUnit(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

function timeframeBase(tf: MarketOverviewTimeframe) {
  const map: Record<MarketOverviewTimeframe, { launched: number; migratedShare: number; volume: number; traders: number; avgMarketCapUsd: number; activeTokens: number }> = {
    "1h": { launched: 640, migratedShare: 0.018, volume: 63180, traders: 24500, avgMarketCapUsd: 12500, activeTokens: 420 },
    "6h": { launched: 3840, migratedShare: 0.021, volume: 382000, traders: 132000, avgMarketCapUsd: 11800, activeTokens: 2580 },
    "24h": { launched: 15300, migratedShare: 0.026, volume: 1540000, traders: 498000, avgMarketCapUsd: 10500, activeTokens: 10200 },
    "7d": { launched: 108000, migratedShare: 0.011, volume: 16300000, traders: 1700000, avgMarketCapUsd: 9200, activeTokens: 72000 },
    "30d": { launched: 805300, migratedShare: 0.010, volume: 670315570, traders: 3800000, avgMarketCapUsd: 8500, activeTokens: 540000 },
    "90d": { launched: 2415900, migratedShare: 0.009, volume: 2010946710, traders: 11400000, avgMarketCapUsd: 7800, activeTokens: 1620000 },
    "180d": { launched: 4831800, migratedShare: 0.008, volume: 4021893420, traders: 22800000, avgMarketCapUsd: 7200, activeTokens: 3240000 },
    "365d": { launched: 9663600, migratedShare: 0.007, volume: 8043786840, traders: 45600000, avgMarketCapUsd: 6800, activeTokens: 6480000 },
    "all": { launched: 9663600, migratedShare: 0.007, volume: 8043786840, traders: 45600000, avgMarketCapUsd: 6800, activeTokens: 6480000 },
  };
  return map[tf];
}

function generateSeries(timeframe: MarketOverviewTimeframe, timeframeMs: number, intervalMs: number, baseValue: number, volatility: number): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = [];
  const now = Date.now();
  const numPoints = Math.max(1, Math.floor(timeframeMs / intervalMs));
  for (let i = 0; i < numPoints; i++) {
    const timestamp = now - (numPoints - i) * intervalMs;
    const progress = numPoints <= 1 ? 1 : i / (numPoints - 1);
    const waveA = Math.sin(progress * Math.PI * 2.6) * volatility;
    const waveB = Math.cos(progress * Math.PI * 5.2) * volatility * 0.45;
    const noise = (seededUnit(`${timeframe}-${baseValue}-${i}`) - 0.5) * volatility * 0.6;
    const trend = 1 + waveA + waveB + noise;
    const value = Math.max(0, baseValue * trend);
    points.push({ timestamp, value });
  }
  return points;
}

function buildFallbackData(timeframe: MarketOverviewTimeframe, reason: string): MarketOverviewData {
  const timeframeMs = getTimeframeMs(timeframe);
  const intervalMs = getInterval(timeframe).ms;
  const base = timeframeBase(timeframe);
  const totalLaunched = base.launched;
  const migratedTokens = Math.round(base.launched * base.migratedShare);
  const migrationShare = totalLaunched > 0 ? (migratedTokens / totalLaunched) * 100 : 0;
  const totalVolumeSol = base.volume;
  const beforeMigrationVolume = totalVolumeSol * 0.57;
  const afterMigrationVolume = totalVolumeSol * 0.43;
  const totalTraders = base.traders;
  const beforeMigrationTraders = totalTraders * 0.34;
  const afterMigrationTraders = totalTraders * 0.66;
  const newWallets = Math.max(0, Math.round(totalLaunched * 0.28));
  const totalBotFees = totalVolumeSol * 0.003;
  const beforeMigrationFees = beforeMigrationVolume * 0.003;
  const afterMigrationFees = afterMigrationVolume * 0.003;
  const avgMarketCapUsd = base.avgMarketCapUsd;
  const solPrice = 150;
  const avgMarketCapSol = avgMarketCapUsd / solPrice;
  const activeTokens = base.activeTokens;
  const pointsCount = Math.max(1, Math.floor(timeframeMs / intervalMs));
  let twitterSocial: TwitterSocialStats;
  try {
    twitterSocial = getTwitterSocialStats(Date.now() - timeframeMs, intervalMs);
  } catch (error) {
    console.warn("[market-overview] Twitter stats fallback:", error);
    twitterSocial = emptyTwitterSocialStats();
  }
  return {
    launched: { total: totalLaunched, trend: generateSeries(timeframe, timeframeMs, intervalMs, totalLaunched / pointsCount, 0.26) },
    migrated: { total: migratedTokens, share: migrationShare, trend: generateSeries(timeframe, timeframeMs, intervalMs, migratedTokens / pointsCount, 0.2) },
    volume: { totalSol: totalVolumeSol, beforeMigration: beforeMigrationVolume, afterMigration: afterMigrationVolume, trend: generateSeries(timeframe, timeframeMs, intervalMs, totalVolumeSol / pointsCount, 0.34) },
    traders: { total: totalTraders, beforeMigration: beforeMigrationTraders, afterMigration: afterMigrationTraders, trend: generateSeries(timeframe, timeframeMs, intervalMs, totalTraders / pointsCount, 0.22) },
    newWallets: { total: newWallets, trend: generateSeries(timeframe, timeframeMs, intervalMs, newWallets / pointsCount, 0.3) },
    botFees: { totalSol: totalBotFees, beforeMigration: beforeMigrationFees, afterMigration: afterMigrationFees, trend: generateSeries(timeframe, timeframeMs, intervalMs, totalBotFees / pointsCount, 0.18) },
    marketCap: { avgUsd: avgMarketCapUsd, avgSol: avgMarketCapSol, trend: generateSeries(timeframe, timeframeMs, intervalMs, avgMarketCapSol, 0.15) },
    activeTokens: { total: activeTokens, trend: generateSeries(timeframe, timeframeMs, intervalMs, activeTokens / pointsCount, 0.12) },
    twitterSocial,
    meta: {
      source: "fallback",
      fallback: true,
      reason,
      updatedAt: Date.now(),
      solPriceUsd: solPrice,
      sampledMarketCaps: 0,
      bitqueryConfigured: Boolean(BITQUERY_KEY),
      collectorConfigured: true,
    },
  };
}

function buildSqliteData(timeframe: MarketOverviewTimeframe, solPrice: number): MarketOverviewData {
  const timeframeMs = getTimeframeMs(timeframe);
  const intervalMs = getInterval(timeframe).ms;
  const since = Date.now() - timeframeMs;
  const agg = getMarketOverviewAggregate(since);
  const series = getMarketEventSeries(since, intervalMs);
  const walletSeries = getNewWalletSeries(since, intervalMs);
  const twitterSocial = getTwitterSocialStats(since, intervalMs);
  const { points } = getBucketTimeline(timeframe);

  const seriesMap = new Map<number, { launched: number; migrated: number; volumeSol: number; traders: number; activeTokens: number }>();
  for (const row of series) {
    seriesMap.set(row.bucket, row);
  }

  const launchedTrend: TimeSeriesPoint[] = [];
  const migratedTrend: TimeSeriesPoint[] = [];
  const volumeTrend: TimeSeriesPoint[] = [];
  const tradersTrend: TimeSeriesPoint[] = [];
  const newWalletsTrend: TimeSeriesPoint[] = [];
  const activeTokensTrend: TimeSeriesPoint[] = [];
  const marketCapTrend: TimeSeriesPoint[] = [];
  const walletSeriesMap = new Map(walletSeries.map((entry) => [entry.bucket, entry.wallets] as const));

  for (const timestamp of points) {
    const row = seriesMap.get(timestamp) ?? { launched: 0, migrated: 0, volumeSol: 0, traders: 0, activeTokens: 0 };
    launchedTrend.push({ timestamp, value: row.launched });
    migratedTrend.push({ timestamp, value: row.migrated });
    volumeTrend.push({ timestamp, value: row.volumeSol });
    tradersTrend.push({ timestamp, value: row.traders });
    newWalletsTrend.push({ timestamp, value: walletSeriesMap.get(timestamp) ?? 0 });
    activeTokensTrend.push({ timestamp, value: row.activeTokens });
    marketCapTrend.push({ timestamp, value: agg.avgMarketCapSol });
  }

  const migrationShare = agg.launched > 0 ? (agg.migrated / agg.launched) * 100 : 0;
  const totalFeesSol = agg.totalVolumeSol * 0.003;
  const beforeFeesSol = agg.beforeMigrationVolumeSol * 0.003;
  const afterFeesSol = agg.afterMigrationVolumeSol * 0.003;

  return {
    launched: { total: agg.launched, trend: launchedTrend },
    migrated: { total: agg.migrated, share: migrationShare, trend: migratedTrend },
    volume: { totalSol: agg.totalVolumeSol, beforeMigration: agg.beforeMigrationVolumeSol, afterMigration: agg.afterMigrationVolumeSol, trend: volumeTrend },
    traders: { total: agg.totalTraders, beforeMigration: agg.beforeMigrationTraders, afterMigration: agg.afterMigrationTraders, trend: tradersTrend },
    newWallets: {
      total: agg.newWallets,
      trend: newWalletsTrend,
    },
    botFees: { totalSol: totalFeesSol, beforeMigration: beforeFeesSol, afterMigration: afterFeesSol, trend: volumeTrend.map((p) => ({ timestamp: p.timestamp, value: p.value * 0.003 })) },
    marketCap: { avgUsd: agg.avgMarketCapSol * solPrice, avgSol: agg.avgMarketCapSol, trend: marketCapTrend },
    activeTokens: { total: agg.activeTokens, trend: activeTokensTrend },
    twitterSocial,
    meta: {
      source: "sqlite",
      fallback: false,
      reason: null,
      updatedAt: Date.now(),
      solPriceUsd: solPrice,
      sampledMarketCaps: agg.sampledMarketCaps,
      bitqueryConfigured: Boolean(BITQUERY_KEY),
      collectorConfigured: true,
    },
  };
}

function toNumber(value: string | number | null | undefined) {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(num) ? num : 0;
}

function bucketTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

async function fetchSolPriceUsd() {
  try {
    const response = await fetch("https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112", {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return 150;
    const payload = await response.json() as { pairs?: Array<{ chainId?: string; liquidity?: { usd?: number }; priceUsd?: string }> };
    const best = (payload.pairs ?? [])
      .filter((pair) => pair.chainId === "solana" && Number(pair.priceUsd) > 0)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const price = Number(best?.priceUsd);
    return Number.isFinite(price) && price > 0 ? price : 150;
  } catch {
    return 150;
  }
}

function getBucketTimeline(timeframe: MarketOverviewTimeframe) {
  const timeframeMs = getTimeframeMs(timeframe);
  const interval = getInterval(timeframe);
  const now = Date.now();
  const start = now - timeframeMs;
  const points: number[] = [];
  const alignedStart = Math.floor(start / interval.ms) * interval.ms;
  for (let ts = alignedStart; ts <= now; ts += interval.ms) {
    points.push(ts);
  }
  return { points, interval };
}

function mapInstructionSeries(rows: InstructionRow[]) {
  const map = new Map<number, number>();
  for (const row of rows) {
    const ts = bucketTimestamp(row.Block?.Time);
    if (ts == null) continue;
    map.set(ts, toNumber(row.count));
  }
  return map;
}

function mapTradeSeries(rows: TradeAggregateRow[]) {
  const map = new Map<number, { volumeUsd: number; traders: number; activeTokens: number }>();
  for (const row of rows) {
    const ts = bucketTimestamp(row.Block?.Time);
    if (ts == null) continue;
    map.set(ts, {
      volumeUsd: toNumber(row.volumeUsd),
      traders: toNumber(row.traders),
      activeTokens: toNumber(row.activeTokens),
    });
  }
  return map;
}

async function fetchBitqueryMarketOverview(timeframe: MarketOverviewTimeframe): Promise<MarketOverviewData | null> {
  if (!BITQUERY_KEY) return null;

  const sinceMs = Date.now() - getTimeframeMs(timeframe);
  const since = new Date(sinceMs).toISOString();
  const interval = getInterval(timeframe);
  let twitterSocial: TwitterSocialStats;
  let walletSeries: Array<{ bucket: number; wallets: number }>;
  try {
    twitterSocial = getTwitterSocialStats(sinceMs, interval.ms);
  } catch (error) {
    console.warn("[market-overview] Twitter stats unavailable for Bitquery path:", error);
    twitterSocial = emptyTwitterSocialStats();
  }
  try {
    walletSeries = getNewWalletSeries(sinceMs, interval.ms);
  } catch (error) {
    console.warn("[market-overview] Wallet series unavailable for Bitquery path:", error);
    walletSeries = [];
  }
  const query = `
    query MarketOverview {
      Solana(dataset: combined, network: solana) {
        launchedSeries: Instructions(
          where: {
            Transaction: { Result: { Success: true } }
            Block: { Time: { since: "${since}" } }
            Instruction: { Program: { Address: { is: "${PUMP_FUN_PROGRAM}" }, Method: { in: ["create", "create_v2"] } } }
          }
          orderBy: { ascendingByField: "Block_Time" }
        ) {
          Block { Time(interval: { in: ${interval.unit}, count: ${interval.count} }) }
          count
        }
        launchedTotal: Instructions(
          where: {
            Transaction: { Result: { Success: true } }
            Block: { Time: { since: "${since}" } }
            Instruction: { Program: { Address: { is: "${PUMP_FUN_PROGRAM}" }, Method: { in: ["create", "create_v2"] } } }
          }
        ) {
          count
        }
        migratedSeries: Instructions(
          where: {
            Transaction: { Result: { Success: true } }
            Block: { Time: { since: "${since}" } }
            Instruction: {
              Depth: { eq: 1 }
              Program: {
                Address: { is: "${PUMP_SWAP_PROGRAM}" }
                Method: { is: "create_pool" }
              }
            }
          }
          orderBy: { ascendingByField: "Block_Time" }
        ) {
          Block { Time(interval: { in: ${interval.unit}, count: ${interval.count} }) }
          count
        }
        migratedTotal: Instructions(
          where: {
            Transaction: { Result: { Success: true } }
            Block: { Time: { since: "${since}" } }
            Instruction: {
              Depth: { eq: 1 }
              Program: {
                Address: { is: "${PUMP_SWAP_PROGRAM}" }
                Method: { is: "create_pool" }
              }
            }
          }
        ) {
          count
        }
        combinedTradeSeries: DEXTradeByTokens(
          where: {
            Transaction: { Result: { Success: true } }
            Block: { Time: { since: "${since}" } }
            Trade: {
              Dex: { ProgramAddress: { in: ["${PUMP_FUN_PROGRAM}", "${PUMP_SWAP_PROGRAM}"] } }
              Currency: { MintAddress: { notIn: ["${SOL_MINT}", "${SYSTEM_PROGRAM}"] } }
            }
          }
          orderBy: { ascendingByField: "Block_Time" }
        ) {
          Block { Time(interval: { in: ${interval.unit}, count: ${interval.count} }) }
          volumeUsd: sum(of: Trade_Side_AmountInUSD)
          traders: count(distinct: Transaction_Signer)
          activeTokens: count(distinct: Trade_Currency_MintAddress)
        }
        combinedTradeTotals: DEXTradeByTokens(
          where: {
            Transaction: { Result: { Success: true } }
            Block: { Time: { since: "${since}" } }
            Trade: {
              Dex: { ProgramAddress: { in: ["${PUMP_FUN_PROGRAM}", "${PUMP_SWAP_PROGRAM}"] } }
              Currency: { MintAddress: { notIn: ["${SOL_MINT}", "${SYSTEM_PROGRAM}"] } }
            }
          }
        ) {
          volumeUsd: sum(of: Trade_Side_AmountInUSD)
          traders: count(distinct: Transaction_Signer)
          activeTokens: count(distinct: Trade_Currency_MintAddress)
        }
        preTradeSeries: DEXTradeByTokens(
          where: {
            Transaction: { Result: { Success: true } }
            Block: { Time: { since: "${since}" } }
            Trade: {
              Dex: { ProgramAddress: { is: "${PUMP_FUN_PROGRAM}" } }
              Currency: { MintAddress: { notIn: ["${SOL_MINT}", "${SYSTEM_PROGRAM}"] } }
            }
          }
          orderBy: { ascendingByField: "Block_Time" }
        ) {
          Block { Time(interval: { in: ${interval.unit}, count: ${interval.count} }) }
          volumeUsd: sum(of: Trade_Side_AmountInUSD)
          traders: count(distinct: Transaction_Signer)
        }
        preTradeTotals: DEXTradeByTokens(
          where: {
            Transaction: { Result: { Success: true } }
            Block: { Time: { since: "${since}" } }
            Trade: {
              Dex: { ProgramAddress: { is: "${PUMP_FUN_PROGRAM}" } }
              Currency: { MintAddress: { notIn: ["${SOL_MINT}", "${SYSTEM_PROGRAM}"] } }
            }
          }
        ) {
          volumeUsd: sum(of: Trade_Side_AmountInUSD)
          traders: count(distinct: Transaction_Signer)
        }
        postTradeSeries: DEXTradeByTokens(
          where: {
            Transaction: { Result: { Success: true } }
            Block: { Time: { since: "${since}" } }
            Trade: {
              Dex: { ProgramAddress: { is: "${PUMP_SWAP_PROGRAM}" } }
              Currency: { MintAddress: { notIn: ["${SOL_MINT}", "${SYSTEM_PROGRAM}"] } }
            }
          }
          orderBy: { ascendingByField: "Block_Time" }
        ) {
          Block { Time(interval: { in: ${interval.unit}, count: ${interval.count} }) }
          volumeUsd: sum(of: Trade_Side_AmountInUSD)
          traders: count(distinct: Transaction_Signer)
        }
        postTradeTotals: DEXTradeByTokens(
          where: {
            Transaction: { Result: { Success: true } }
            Block: { Time: { since: "${since}" } }
            Trade: {
              Dex: { ProgramAddress: { is: "${PUMP_SWAP_PROGRAM}" } }
              Currency: { MintAddress: { notIn: ["${SOL_MINT}", "${SYSTEM_PROGRAM}"] } }
            }
          }
        ) {
          volumeUsd: sum(of: Trade_Side_AmountInUSD)
          traders: count(distinct: Transaction_Signer)
        }
        marketCapSample: DEXTradeByTokens(
          where: {
            Transaction: { Result: { Success: true } }
            Block: { Time: { since: "${since}" } }
            Trade: {
              Dex: { ProgramAddress: { in: ["${PUMP_FUN_PROGRAM}", "${PUMP_SWAP_PROGRAM}"] } }
              Currency: { MintAddress: { notIn: ["${SOL_MINT}", "${SYSTEM_PROGRAM}"] } }
            }
          }
          orderBy: { descendingByField: "Block_Time" }
          limit: { count: 500 }
        ) {
          Trade { Currency { MintAddress } }
          Supply { MarketCap }
        }
      }
    }
  `;

  const [solPriceUsd, response] = await Promise.all([
    fetchSolPriceUsd(),
    fetch(BITQUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": BITQUERY_KEY,
      },
      body: JSON.stringify({ query }),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    }),
  ]);

  if (!response.ok) {
    throw new Error(`bitquery_${response.status}`);
  }

  const payload = await response.json() as BitqueryResponse;
  if (payload.errors?.length) {
    throw new Error(payload.errors[0]?.message || "bitquery_error");
  }

  const result = payload.data?.Solana;
  if (!result) {
    throw new Error("bitquery_empty");
  }

  const launchedSeries = mapInstructionSeries(result.launchedSeries ?? []);
  const migratedSeries = mapInstructionSeries(result.migratedSeries ?? []);
  const combinedTradeSeries = mapTradeSeries(result.combinedTradeSeries ?? []);
  const preTradeSeries = mapTradeSeries(result.preTradeSeries ?? []);
  const postTradeSeries = mapTradeSeries(result.postTradeSeries ?? []);
  const combinedTotals = result.combinedTradeTotals?.[0];
  const preTotals = result.preTradeTotals?.[0];
  const postTotals = result.postTradeTotals?.[0];

  const launchedTotal = result.launchedTotal?.reduce((sum, row) => sum + toNumber(row.count), 0) ?? 0;
  const migratedTotal = result.migratedTotal?.reduce((sum, row) => sum + toNumber(row.count), 0) ?? 0;
  const volumeTotalUsd = toNumber(combinedTotals?.volumeUsd);
  const volumeBeforeUsd = toNumber(preTotals?.volumeUsd);
  const volumeAfterUsd = toNumber(postTotals?.volumeUsd);
  const tradersTotal = toNumber(combinedTotals?.traders);
  const tradersBefore = toNumber(preTotals?.traders);
  const tradersAfter = toNumber(postTotals?.traders);
  const activeTokensTotal = toNumber(combinedTotals?.activeTokens);

  const marketCaps = new Map<string, number>();
  for (const row of result.marketCapSample ?? []) {
    const mint = row.Trade?.Currency?.MintAddress?.trim();
    const marketCap = toNumber(row.Supply?.MarketCap);
    if (!mint || marketCap <= 0 || marketCaps.has(mint)) continue;
    marketCaps.set(mint, marketCap);
    if (marketCaps.size >= 150) break;
  }
  const sampledMarketCaps = marketCaps.size;
  const avgMarketCapUsd = sampledMarketCaps > 0
    ? Array.from(marketCaps.values()).reduce((sum, value) => sum + value, 0) / sampledMarketCaps
    : 0;

  const { points } = getBucketTimeline(timeframe);
  const volumeTrend: TimeSeriesPoint[] = [];
  const tradersTrend: TimeSeriesPoint[] = [];
  const activeTokensTrend: TimeSeriesPoint[] = [];
  const launchedTrend: TimeSeriesPoint[] = [];
  const migratedTrend: TimeSeriesPoint[] = [];
  const newWalletsTrend: TimeSeriesPoint[] = [];
  const marketCapTrend: TimeSeriesPoint[] = [];

  for (const timestamp of points) {
    const launchValue = launchedSeries.get(timestamp) ?? 0;
    const migrationValue = migratedSeries.get(timestamp) ?? 0;
    const combinedTrade = combinedTradeSeries.get(timestamp) ?? { volumeUsd: 0, traders: 0, activeTokens: 0 };
    launchedTrend.push({ timestamp, value: launchValue });
    migratedTrend.push({ timestamp, value: migrationValue });
    volumeTrend.push({ timestamp, value: combinedTrade.volumeUsd / solPriceUsd });
    tradersTrend.push({ timestamp, value: combinedTrade.traders });
    activeTokensTrend.push({ timestamp, value: combinedTrade.activeTokens });
    const walletBucket = walletSeries.find((entry) => entry.bucket === timestamp);
    newWalletsTrend.push({ timestamp, value: walletBucket?.wallets ?? 0 });
    marketCapTrend.push({ timestamp, value: avgMarketCapUsd / solPriceUsd });
    void preTradeSeries;
    void postTradeSeries;
  }

  const volumeTotalSol = volumeTotalUsd / solPriceUsd;
  const beforeMigrationVolumeSol = volumeBeforeUsd / solPriceUsd;
  const afterMigrationVolumeSol = volumeAfterUsd / solPriceUsd;
  const totalFeesSol = volumeTotalSol * 0.003;
  const beforeFeesSol = beforeMigrationVolumeSol * 0.003;
  const afterFeesSol = afterMigrationVolumeSol * 0.003;
  const migrationShare = launchedTotal > 0 ? (migratedTotal / launchedTotal) * 100 : 0;

  return {
    launched: {
      total: launchedTotal,
      trend: launchedTrend,
    },
    migrated: {
      total: migratedTotal,
      share: migrationShare,
      trend: migratedTrend,
    },
    volume: {
      totalSol: volumeTotalSol,
      beforeMigration: beforeMigrationVolumeSol,
      afterMigration: afterMigrationVolumeSol,
      trend: volumeTrend,
    },
    traders: {
      total: tradersTotal,
      beforeMigration: tradersBefore,
      afterMigration: tradersAfter,
      trend: tradersTrend,
    },
    newWallets: {
      total: walletSeries.reduce((sum, entry) => sum + entry.wallets, 0),
      trend: newWalletsTrend,
    },
    botFees: {
      totalSol: totalFeesSol,
      beforeMigration: beforeFeesSol,
      afterMigration: afterFeesSol,
      trend: volumeTrend.map((point) => ({ timestamp: point.timestamp, value: point.value * 0.003 })),
    },
    marketCap: {
      avgUsd: avgMarketCapUsd,
      avgSol: avgMarketCapUsd / solPriceUsd,
      trend: marketCapTrend,
    },
    activeTokens: {
      total: activeTokensTotal,
      trend: activeTokensTrend,
    },
    twitterSocial,
    meta: {
      source: "bitquery",
      fallback: false,
      reason: null,
      updatedAt: Date.now(),
      solPriceUsd,
      sampledMarketCaps,
      bitqueryConfigured: true,
      collectorConfigured: true,
    },
  };
}

export async function getMarketOverview(timeframe: MarketOverviewTimeframe): Promise<MarketOverviewData> {
  const cached = cache.get(timeframe);
  const ttl = getCacheTtl(timeframe);
  if (cached && Date.now() - cached.timestamp < ttl) {
    return cached.data;
  }

  const solPrice = await fetchSolPriceUsd();
  let hasCollectedData = false;
  try {
    hasCollectedData = getMarketCollectorStatus().events > 0;
  } catch (error) {
    console.warn("[market-overview] Collector status unavailable, using fallback:", error);
  }

  let data: MarketOverviewData;

  // 1. Prefer locally-collected SQLite data if available
  if (hasCollectedData) {
    try {
      data = buildSqliteData(timeframe, solPrice);
    } catch (error) {
      console.error("[market-overview] SQLite build failed:", error);
      // fall through to next source
      data = buildFallbackData(timeframe, error instanceof Error ? error.message : "SQLite build failed");
    }
  }

  // 2. Try Bitquery if configured and SQLite didn't produce data
  if (!data! || data.meta.fallback) {
    if (BITQUERY_KEY) {
      try {
        const bitqueryData = await fetchBitqueryMarketOverview(timeframe);
        if (bitqueryData) {
          data = bitqueryData;
        }
      } catch (error) {
        console.error("[market-overview] Bitquery failed:", error);
        if (!data!) {
          data = buildFallbackData(timeframe, error instanceof Error ? error.message : "Bitquery fetch failed");
        }
      }
    }
  }

  // 3. Final synthetic fallback
  if (!data!) {
    data = buildFallbackData(timeframe, "No data source available");
  }

  cache.set(timeframe, { data, timestamp: Date.now() });
  return data;
}
