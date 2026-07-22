import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/trade/db";
import { detectBundles } from "@/lib/trade/classify";

export type DatabaseAnalyticsFilters = {
  smartWalletMinRoi: number;
  smartWalletMinPnl: number;
  smartWalletMinWr: number;
  smartWalletMinMigratedTokens: number;
  smartWalletMinMigratedPct: number;
  smartWalletMinFastTrades: number;
  smartWalletMinFastTradesPct: number;
  smartWalletMinReports: number;
  smartWalletMinScore: number;
  successMinAthUsd: number;
  successMinVolumeSol: number;
  successMinSmartWallets: number;
  successMinSmartWalletRoi: number;
  successRequireMigration: boolean;
  insiderRepeatWalletThreshold: number;
  insiderEarlyBuyMinutes: number;
  insiderClusterWindowSec: number;
};

export const DEFAULT_DATABASE_ANALYTICS_FILTERS: DatabaseAnalyticsFilters = {
  smartWalletMinRoi: 50,
  smartWalletMinPnl: 1,
  smartWalletMinWr: 55,
  smartWalletMinMigratedTokens: 5,
  smartWalletMinMigratedPct: 50,
  smartWalletMinFastTrades: 5,
  smartWalletMinFastTradesPct: 20,
  smartWalletMinReports: 3,
  smartWalletMinScore: 4,
  successMinAthUsd: 300_000,
  successMinVolumeSol: 500,
  successMinSmartWallets: 5,
  successMinSmartWalletRoi: 100,
  successRequireMigration: true,
  insiderRepeatWalletThreshold: 3,
  insiderEarlyBuyMinutes: 10,
  insiderClusterWindowSec: 60,
};

export type WalletProfile = {
  wallet: string;
  avgRoi: number | null;
  avgPnl: number | null;
  avgWr: number | null;
  avgFastTrades: number | null;
  avgFastTradesPct: number | null;
  avgMigratedTokens: number | null;
  avgMigratedPct: number | null;
  avgTotalTokens: number | null;
  avgTokenWinRate: number | null;
  reports: number;
  migrationVolume: number | null;
  migrationPnl: number | null;
  tokensTraded: number | null;
  totalBuys: number | null;
  totalSells: number | null;
  totalVolumeSol: number | null;
  totalPnlSol: number | null;
  winRate: number | null;
  freshRate: number | null;
  washRate: number | null;
  bundleRows: number | null;
  score: number;
  reasons: string[];
};

export type TokenBuyerEdge = {
  wallet: string;
  firstBuyAt: number | null;
  lastBuyAt: number | null;
  buyTrades: number;
  buyVolumeSol: number;
};

export type TokenProfile = {
  mint: string;
  creator: string;
  symbol: string | null;
  name: string | null;
  twitter: string | null;
  createdAt: number | null;
  mintTimeText: string | null;
  migrationTimeText: string | null;
  timeBeforeMigrationSeconds: number | null;
  marketCapUsd: number | null;
  athUsd: number | null;
  isMigrated: boolean;
  reached300k: boolean;
  tokenVolumeSol: number | null;
  tokenVolumeUsd: number | null;
  totalUniqueBuyers: number | null;
  totalTrades: number;
  buyTrades: number;
  sellTrades: number;
  firstTradeAt: number | null;
  lastTradeAt: number | null;
  firstBuyAt: number | null;
  lastBuyAt: number | null;
  uniqueBuyers: number;
  buyerEdges: TokenBuyerEdge[];
  bundleCount: number;
  bundleWallets: number;
  buyClusterCount: number;
  clusterWallets: number;
};

export type DatabaseAnalytics = {
  filters: DatabaseAnalyticsFilters;
  walletProfiles: WalletProfile[];
  tokenProfiles: TokenProfile[];
  summary: {
    wallets: number;
    tokens: number;
    creators: number;
    twitterTokens: number;
    totalBuyerEdges: number;
  };
};

type DevTokenRow = {
  mint: string;
  creator: string;
  symbol: string | null;
  name: string | null;
  twitter: string | null;
  createdAt: number | null;
  marketCapUsd: number | null;
  athUsd: number | null;
  isMigrated: number | boolean;
  reached300k: number | boolean;
};

type MigrationWalletAggRow = {
  wallet: string;
  avgRoi: number | null;
  avgPnl: number | null;
  avgWr: number | null;
  avgFastTrades: number | null;
  avgFastTradesPct: number | null;
  avgMigratedTokens: number | null;
  avgMigratedPct: number | null;
  avgTotalTokens: number | null;
  reports: number;
};

type WalletTradeAggRow = {
  wallet: string;
  totalVolumeSol: number | null;
  totalPnlSol: number | null;
  tokensTraded: number | null;
  totalBuys: number | null;
  totalSells: number | null;
  winRate: number | null;
  freshRate: number | null;
  washRate: number | null;
  bundleRows: number | null;
};

type MigrationTokenAggRow = {
  tokenAddress: string;
  totalUniqueBuyers: number | null;
  currentMc: number | null;
  marketCapMax: number | null;
  mintTimeText: string | null;
  migrationTimeText: string | null;
  timeBeforeMigrationSeconds: number | null;
};

type TokenTradeRow = {
  mint: string;
  signature: string;
  timestamp: number;
  trader: string;
  type: string;
  amountSol: number;
  amountTokens: number;
  priceSol: number;
};

type AnalyticsSnapshotPayload = Pick<DatabaseAnalytics, "walletProfiles" | "tokenProfiles" | "summary">;
type AnalyticsSnapshotFile = {
  sourceSignature: string;
  computedAt: number;
  payload: AnalyticsSnapshotPayload;
};

const ANALYTICS_SNAPSHOT_PATH = path.join(process.cwd(), "data", "database-analytics.snapshot.json");

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function parseHour(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const ts = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(ts).getUTCHours();
}

function loadAnalyticsSnapshot(sourceSignature: string): AnalyticsSnapshotPayload | null {
  if (!fs.existsSync(ANALYTICS_SNAPSHOT_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(ANALYTICS_SNAPSHOT_PATH, "utf8")) as AnalyticsSnapshotFile;
    if (parsed.sourceSignature !== sourceSignature) return null;
    return parsed.payload;
  } catch {
    return null;
  }
}

function saveAnalyticsSnapshot(sourceSignature: string, payload: AnalyticsSnapshotPayload) {
  fs.mkdirSync(path.dirname(ANALYTICS_SNAPSHOT_PATH), { recursive: true });
  const file: AnalyticsSnapshotFile = {
    sourceSignature,
    computedAt: Date.now(),
    payload,
  };
  fs.writeFileSync(ANALYTICS_SNAPSHOT_PATH, JSON.stringify(file));
}

function emptyWalletProfile(wallet: string): WalletProfile {
  return {
    wallet,
    avgRoi: null,
    avgPnl: null,
    avgWr: null,
    avgFastTrades: null,
    avgFastTradesPct: null,
    avgMigratedTokens: null,
    avgMigratedPct: null,
    avgTotalTokens: null,
    avgTokenWinRate: null,
    reports: 0,
    migrationVolume: null,
    migrationPnl: null,
    tokensTraded: null,
    totalBuys: null,
    totalSells: null,
    totalVolumeSol: null,
    totalPnlSol: null,
    winRate: null,
    freshRate: null,
    washRate: null,
    bundleRows: null,
    score: 0,
    reasons: [],
  };
}

function scoreWallet(profile: WalletProfile, filters: DatabaseAnalyticsFilters): WalletProfile {
  const reasons: string[] = [];
  let score = 0;

  if ((profile.avgRoi ?? -Infinity) >= filters.smartWalletMinRoi) {
    score += 2;
    reasons.push("roi");
  }
  if ((profile.avgPnl ?? -Infinity) >= filters.smartWalletMinPnl) {
    score += 2;
    reasons.push("pnl");
  }
  if ((profile.avgWr ?? -Infinity) >= filters.smartWalletMinWr) {
    score += 2;
    reasons.push("winrate");
  }
  if ((profile.avgMigratedTokens ?? -Infinity) >= filters.smartWalletMinMigratedTokens) {
    score += 1;
    reasons.push("migrated_tokens");
  }
  if ((profile.avgMigratedPct ?? -Infinity) >= filters.smartWalletMinMigratedPct) {
    score += 1;
    reasons.push("migrated_pct");
  }
  if ((profile.avgFastTrades ?? -Infinity) >= filters.smartWalletMinFastTrades) {
    score += 1;
    reasons.push("fast_trades");
  }
  if ((profile.avgFastTradesPct ?? -Infinity) >= filters.smartWalletMinFastTradesPct) {
    score += 1;
    reasons.push("fast_trades_pct");
  }
  if ((profile.avgTokenWinRate ?? -Infinity) >= 0.55) {
    score += 1;
    reasons.push("token_winrate");
  }
  if ((profile.reports ?? 0) >= filters.smartWalletMinReports) {
    score += 1;
    reasons.push("reports");
  }
  if ((profile.totalPnlSol ?? -Infinity) > 0) {
    score += 1;
    reasons.push("positive_chain_pnl");
  }

  return { ...profile, score, reasons };
}

function loadWalletProfiles(db: ReturnType<typeof getDb>, filters: DatabaseAnalyticsFilters): WalletProfile[] {
  const migrationAggs = db.prepare(
    `SELECT
       wallet,
       AVG(COALESCE(roi, 0)) AS avgRoi,
       AVG(COALESCE(pnl, 0)) AS avgPnl,
       AVG(COALESCE(wr, 0)) AS avgWr,
       AVG(COALESCE(fast_trades, 0)) AS avgFastTrades,
       AVG(COALESCE(fast_trades_pct, 0)) AS avgFastTradesPct,
       AVG(COALESCE(migrated_tokens, 0)) AS avgMigratedTokens,
       AVG(COALESCE(migrated_pct, 0)) AS avgMigratedPct,
       AVG(COALESCE(total_tokens, 0)) AS avgTotalTokens,
       COUNT(*) AS reports
     FROM migration_wallet_rows
     WHERE wallet IS NOT NULL AND wallet != ''
     GROUP BY wallet`
  ).all() as MigrationWalletAggRow[];

  const tradeAggs = db.prepare(
    `SELECT
       address AS wallet,
       total_volume_sol AS totalVolumeSol,
       total_pnl_sol AS totalPnlSol,
       tokens_traded AS tokensTraded,
       total_buys AS totalBuys,
       total_sells AS totalSells
     FROM wallet_stats`
  ).all() as WalletTradeAggRow[];

  const tokenAggs = db.prepare(
    `SELECT
       address AS wallet,
       AVG(CASE WHEN pnl_sol > 0 THEN 1.0 ELSE 0.0 END) AS winRate,
       AVG(CASE WHEN is_fresh = 1 THEN 1.0 ELSE 0.0 END) AS freshRate,
       AVG(CASE WHEN is_wash = 1 THEN 1.0 ELSE 0.0 END) AS washRate,
       SUM(CASE WHEN bundle_id IS NOT NULL THEN 1 ELSE 0 END) AS bundleRows
     FROM wallet_token_stats
     GROUP BY address`
  ).all() as Array<{ wallet: string; winRate: number | null; freshRate: number | null; washRate: number | null; bundleRows: number | null }>;

  const tradeMap = new Map(tradeAggs.map((row) => [row.wallet, row]));
  const tokenMap = new Map(tokenAggs.map((row) => [row.wallet, row]));

  const profiles = migrationAggs.map((row) => {
    const trade = tradeMap.get(row.wallet);
    const token = tokenMap.get(row.wallet);
    const profile = scoreWallet(
      {
        wallet: row.wallet,
        avgRoi: row.avgRoi,
        avgPnl: row.avgPnl,
        avgWr: row.avgWr,
        avgFastTrades: row.avgFastTrades,
        avgFastTradesPct: row.avgFastTradesPct,
        avgMigratedTokens: row.avgMigratedTokens,
        avgMigratedPct: row.avgMigratedPct,
        avgTotalTokens: row.avgTotalTokens,
        avgTokenWinRate: token?.winRate ?? null,
        reports: row.reports,
        migrationVolume: trade?.totalVolumeSol ?? null,
        migrationPnl: trade?.totalPnlSol ?? null,
        tokensTraded: trade?.tokensTraded ?? null,
        totalBuys: trade?.totalBuys ?? null,
        totalSells: trade?.totalSells ?? null,
        totalVolumeSol: trade?.totalVolumeSol ?? null,
        totalPnlSol: trade?.totalPnlSol ?? null,
        winRate: token?.winRate ?? null,
        freshRate: token?.freshRate ?? null,
        washRate: token?.washRate ?? null,
        bundleRows: token?.bundleRows ?? null,
        score: 0,
        reasons: [],
      },
      filters,
    );
    return profile;
  });

  return profiles.sort((a, b) => b.score - a.score || (b.totalPnlSol ?? 0) - (a.totalPnlSol ?? 0));
}

function loadTokenProfiles(db: ReturnType<typeof getDb>): TokenProfile[] {
  const tokenRows = db.prepare(
    `SELECT
       mint,
       creator,
       symbol,
       name,
       twitter,
       created_at AS createdAt,
       market_cap_usd AS marketCapUsd,
       ath_usd AS athUsd,
       is_migrated AS isMigrated,
       reached_300k AS reached300k
     FROM dev_tokens
     WHERE creator IS NOT NULL AND creator != ''`
  ).all() as DevTokenRow[];

  const tokenAggs = db.prepare(
    `SELECT
       token_address AS tokenAddress,
       MAX(total_unique_buyers) AS totalUniqueBuyers,
       MAX(current_mc) AS currentMc,
       MAX(market_cap_max) AS marketCapMax,
       MAX(mint_time_text) AS mintTimeText,
       MAX(migration_time_text) AS migrationTimeText,
       MAX(time_before_migration_seconds) AS timeBeforeMigrationSeconds
     FROM migration_token_rows
     WHERE token_address IS NOT NULL AND token_address != ''
     GROUP BY token_address`
  ).all() as MigrationTokenAggRow[];

  const tokenTrades = db.prepare(
    `SELECT mint, signature, timestamp, trader, type,
            amount_sol AS amountSol, amount_tokens AS amountTokens, price_sol AS priceSol
     FROM token_trades
     ORDER BY mint ASC, timestamp ASC, inserted_at ASC`
  ).all() as TokenTradeRow[];

  const tokenAggMap = new Map(tokenAggs.map((row) => [row.tokenAddress, row]));
  const tradesByMint = new Map<string, TokenTradeRow[]>();
  for (const trade of tokenTrades) {
    const list = tradesByMint.get(trade.mint) ?? [];
    list.push(trade);
    tradesByMint.set(trade.mint, list);
  }

  return tokenRows.map((token) => {
    const agg = tokenAggMap.get(token.mint);
    const trades = tradesByMint.get(token.mint) ?? [];
    const buyerMap = new Map<string, TokenBuyerEdge>();
    const buyTimes: number[] = [];
    let totalTrades = 0;
    let buyTrades = 0;
    let sellTrades = 0;
    let firstTradeAt: number | null = null;
    let lastTradeAt: number | null = null;
    let firstBuyAt: number | null = null;
    let lastBuyAt: number | null = null;
    let buyVolumeSol = 0;
    let sellVolumeSol = 0;
    let clusterCount = 0;
    let clusterWallets = 0;

    for (const trade of trades) {
      totalTrades += 1;
      if (firstTradeAt === null || trade.timestamp < firstTradeAt) firstTradeAt = trade.timestamp;
      if (lastTradeAt === null || trade.timestamp > lastTradeAt) lastTradeAt = trade.timestamp;
      if (trade.type === "buy") {
        buyTrades += 1;
        buyVolumeSol += trade.amountSol;
        buyTimes.push(trade.timestamp);
        const entry = buyerMap.get(trade.trader) ?? {
          wallet: trade.trader,
          firstBuyAt: trade.timestamp,
          lastBuyAt: trade.timestamp,
          buyTrades: 0,
          buyVolumeSol: 0,
        };
        entry.buyTrades += 1;
        entry.buyVolumeSol += trade.amountSol;
        entry.firstBuyAt = entry.firstBuyAt === null ? trade.timestamp : Math.min(entry.firstBuyAt, trade.timestamp);
        entry.lastBuyAt = entry.lastBuyAt === null ? trade.timestamp : Math.max(entry.lastBuyAt, trade.timestamp);
        buyerMap.set(trade.trader, entry);
        if (firstBuyAt === null || trade.timestamp < firstBuyAt) firstBuyAt = trade.timestamp;
        if (lastBuyAt === null || trade.timestamp > lastBuyAt) lastBuyAt = trade.timestamp;
      } else if (trade.type === "sell") {
        sellTrades += 1;
        sellVolumeSol += trade.amountSol;
      }
    }
    const tokenVolumeSol = trades.reduce((sum, trade) => sum + trade.amountSol, 0);

    const bundles = trades.length > 0 ? detectBundles(trades as Parameters<typeof detectBundles>[0]) : { bundles: [] };
    const bundleCount = bundles.bundles.length;
    const bundleWalletsCount = bundles.bundles.reduce((sum, bundle) => sum + bundle.wallets.length, 0);

    const sortedBuyTimes = [...buyTimes].sort((a, b) => a - b);
    for (let i = 1; i < sortedBuyTimes.length; i += 1) {
      if (sortedBuyTimes[i] - sortedBuyTimes[i - 1] <= DEFAULT_DATABASE_ANALYTICS_FILTERS.insiderClusterWindowSec) {
        clusterCount += 1;
      }
    }
    clusterWallets = buyerMap.size;

    return {
      mint: token.mint,
      creator: token.creator,
      symbol: token.symbol ?? null,
      name: token.name ?? null,
      twitter: token.twitter ?? null,
      createdAt: token.createdAt ?? null,
      mintTimeText: agg?.mintTimeText ?? null,
      migrationTimeText: agg?.migrationTimeText ?? null,
      timeBeforeMigrationSeconds: agg?.timeBeforeMigrationSeconds ?? null,
      marketCapUsd: token.marketCapUsd ?? agg?.currentMc ?? null,
      athUsd: token.athUsd ?? agg?.marketCapMax ?? null,
      isMigrated: Boolean(token.isMigrated),
      reached300k: Boolean(token.reached300k),
      tokenVolumeSol,
      tokenVolumeUsd: tokenVolumeSol > 0 ? tokenVolumeSol * 150 : null,
      totalUniqueBuyers: agg?.totalUniqueBuyers ?? null,
      totalTrades,
      buyTrades,
      sellTrades,
      firstTradeAt,
      lastTradeAt,
      firstBuyAt,
      lastBuyAt,
      uniqueBuyers: buyerMap.size,
      buyerEdges: Array.from(buyerMap.values()).sort((a, b) => (b.buyVolumeSol - a.buyVolumeSol) || (a.wallet < b.wallet ? -1 : 1)),
      bundleCount,
      bundleWallets: bundleWalletsCount,
      buyClusterCount: clusterCount,
      clusterWallets,
    } satisfies TokenProfile;
  });
}

export function buildDatabaseAnalytics(
  filters: DatabaseAnalyticsFilters = DEFAULT_DATABASE_ANALYTICS_FILTERS,
  sourceSignature?: string,
): DatabaseAnalytics {
  const db = getDb();
  if (sourceSignature) {
    const cached = loadAnalyticsSnapshot(sourceSignature);
    if (cached) {
      return {
        filters,
        ...cached,
      };
    }
  }

  const walletProfiles = loadWalletProfiles(db, filters);
  const tokenProfiles = loadTokenProfiles(db);
  const creators = new Set(tokenProfiles.map((token) => token.creator));
  const twitterTokens = tokenProfiles.filter((token) => Boolean(token.twitter)).length;
  const totalBuyerEdges = tokenProfiles.reduce((sum, token) => sum + token.buyerEdges.length, 0);

  const payload: AnalyticsSnapshotPayload = {
    walletProfiles,
    tokenProfiles,
    summary: {
      wallets: walletProfiles.length,
      tokens: tokenProfiles.length,
      creators: creators.size,
      twitterTokens,
      totalBuyerEdges,
    },
  };

  if (sourceSignature) {
    saveAnalyticsSnapshot(sourceSignature, payload);
  }

  return {
    filters,
    ...payload,
  };
}
