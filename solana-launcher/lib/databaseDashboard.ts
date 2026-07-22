import fs from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import {
  getDb,
  getMarketCollectorStatus,
  getMarketOverviewAggregate,
  listMigrationTokenRows,
  listMigrationWalletRows,
  listMigrationXlsxFiles,
  listTopDevWallets,
  type DevWalletRow,
} from "@/lib/trade/db";

const DB_PATH = path.join(process.cwd(), "data", "trade.db");
const DISPLAY_LIMIT = 8;
const MARKET_WINDOW_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_CACHE_TTL_MS = 10_000;

export type TableCount = { table: string; rows: number | null };
export type WorkbookKindRow = { workbookKind: string; files: number; tokenRows: number; walletRows: number };
export type RecentImportRow = { fileName: string; workbookKind: string; sheetCount: number; totalRows: number; tokenRows: number; walletRows: number; importedAt: number };
export type RecentTokenRow = { fileName: string; sheetName: string; tokenAddress: string; ticker: string | null; creator: string | null; currentMc: number | null; marketCapMax: number | null; totalUniqueBuyers: number | null };
export type RecentWalletRow = { fileName: string; sheetName: string; wallet: string; pnl: number | null; roi: number | null; totalTokens: number | null; migratedTokens: number | null };
export type CreatorRow = { creator: string; tokens: number; migrated: number; avgMcap: number | null };
export type WalletStatsRow = { address: string; totalVolumeSol: number; totalPnlSol: number; tokensTraded: number; totalBuys: number; totalSells: number; firstSeen: number; lastUpdatedAt: number };
export type WalletTokenStatRow = { address: string; mint: string; buys: number; sells: number; volumeSol: number; pnlSol: number; pnlPercent: number; isFresh: number | boolean; isWash: number | boolean; bundleId: string | null; updatedAt: number };
export type AnalyzedMintRow = { mint: string; firstAnalyzedAt: number; lastAnalyzedAt: number; analysesCount: number; totalVolumeSol: number | null; totalTrades: number | null; uniqueWallets: number | null; devAddress: string | null; periodStart: number | null; periodEnd: number | null };
export type ApifyRunSummaryRow = { runId: string; actorId: string; actorType: string; status: string; defaultDatasetId: string | null; startedAt: number; finishedAt: number | null; inputJson: string | null; metaJson: string | null; lastSyncedAt: number };
export type ApifySyncEventSummaryRow = { source: string; runId: string | null; datasetId: string | null; status: string; importedItems: number; importedCreators: number; importedTokens: number; message: string | null; createdAt: number };
export type DevForensicsSummaryRow = { creator: string; sourceMint: string | null; totalCreatedTokens: number; totalMigratedTokens: number; migrationRate: number; avgLifespanMinutes: number | null; successRate: number; analyzedAt: number };

export type MarketCollectorStatus = ReturnType<typeof getMarketCollectorStatus>;
export type MarketOverview24h = ReturnType<typeof getMarketOverviewAggregate>;

export type DatabaseDashboardData = {
  integrity: string;
  foreignKeyViolations: unknown[];
  dbPath: string;
  totalRows: number;
  tableCounts: TableCount[];
  migrationKinds: WorkbookKindRow[];
  recentImports: RecentImportRow[];
  recentTokens: RecentTokenRow[];
  recentWallets: RecentWalletRow[];
  topMigrationTokens: RecentTokenRow[];
  topMigrationWallets: Array<RecentWalletRow & { fileName: string }>;
  worstMigrationWallets: Array<RecentWalletRow & { fileName: string }>;
  topCreators: CreatorRow[];
  topWalletStats: WalletStatsRow[];
  topWalletTokenStats: WalletTokenStatRow[];
  analyzedMints: AnalyzedMintRow[];
  devWalletsTokens: DevWalletRow[];
  devWalletsMigration: DevWalletRow[];
  devWallets300k: DevWalletRow[];
  devTokens: Array<{
    mint: string;
    creator: string;
    symbol: string | null;
    name: string | null;
    createdAt: number | null;
    marketCapUsd: number | null;
    athUsd: number | null;
    isMigrated: number | boolean;
    reached300k: number | boolean;
    source: string;
    lastUpdatedAt: number;
  }>;
  devForensics: DevForensicsSummaryRow[];
  apifyRuns: ApifyRunSummaryRow[];
  apifySyncEvents: ApifySyncEventSummaryRow[];
  marketStatus: MarketCollectorStatus;
  marketAgg: MarketOverview24h;
};

function getDashboardSignature() {
  try {
    const stat = fs.statSync(DB_PATH);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function countRows(db: ReturnType<typeof getDb>, tableName: string): number | null {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${tableName}`).get() as { c: number };
  return row.c;
}

function buildDatabaseDashboard() {
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;

  const tableCounts: TableCount[] = tables.map(({ name }) => ({ table: name, rows: countRows(db, name) }));
  const migrationKinds = db.prepare(
    `SELECT workbook_kind AS workbookKind, COUNT(*) AS files, COALESCE(SUM(token_rows), 0) AS tokenRows, COALESCE(SUM(wallet_rows), 0) AS walletRows
     FROM migration_xlsx_files
     GROUP BY workbook_kind
     ORDER BY files DESC, workbook_kind ASC`
  ).all() as WorkbookKindRow[];

  const recentImports = listMigrationXlsxFiles(DISPLAY_LIMIT).map((row) => ({
    fileName: row.fileName,
    workbookKind: row.workbookKind,
    sheetCount: row.sheetCount,
    totalRows: row.totalRows,
    tokenRows: row.tokenRows,
    walletRows: row.walletRows,
    importedAt: row.importedAt ?? 0,
  })) as RecentImportRow[];

  const recentTokens = listMigrationTokenRows(undefined, DISPLAY_LIMIT).map((row) => ({
    fileName: row.fileName,
    sheetName: row.sheetName,
    tokenAddress: row.tokenAddress,
    ticker: row.ticker,
    creator: row.creator,
    currentMc: row.currentMc,
    marketCapMax: row.marketCapMax,
    totalUniqueBuyers: row.totalUniqueBuyers,
  })) as RecentTokenRow[];

  const recentWallets = listMigrationWalletRows(undefined, DISPLAY_LIMIT).map((row) => ({
    fileName: row.fileName,
    sheetName: row.sheetName,
    wallet: row.wallet,
    pnl: row.pnl,
    roi: row.roi,
    totalTokens: row.totalTokens,
    migratedTokens: row.migratedTokens,
  })) as RecentWalletRow[];

  const topMigrationTokens = db.prepare(
    `SELECT token_address AS tokenAddress, ticker, creator, current_mc AS currentMc, market_cap_max AS marketCapMax, total_unique_buyers AS totalUniqueBuyers, file_name AS fileName, sheet_name AS sheetName
     FROM migration_token_rows
     ORDER BY COALESCE(market_cap_max, current_mc) DESC, total_unique_buyers DESC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as Array<RecentTokenRow>;

  const topMigrationWallets = db.prepare(
    `SELECT wallet, pnl, roi, total_tokens AS totalTokens, migrated_tokens AS migratedTokens, file_name AS fileName
     FROM migration_wallet_rows
     ORDER BY pnl DESC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as Array<RecentWalletRow & { fileName: string }>;

  const worstMigrationWallets = db.prepare(
    `SELECT wallet, pnl, roi, total_tokens AS totalTokens, migrated_tokens AS migratedTokens, file_name AS fileName
     FROM migration_wallet_rows
     ORDER BY pnl ASC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as Array<RecentWalletRow & { fileName: string }>;

  const topCreators = db.prepare(
    `SELECT creator, COUNT(*) AS tokens, SUM(CASE WHEN COALESCE(market_cap_max, current_mc, 0) >= 300000 THEN 1 ELSE 0 END) AS migrated, AVG(COALESCE(market_cap_max, current_mc)) AS avgMcap
     FROM migration_token_rows
     WHERE creator IS NOT NULL AND creator != ''
     GROUP BY creator
     ORDER BY tokens DESC, migrated DESC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as CreatorRow[];

  const topWalletStats = db.prepare(
    `SELECT address, total_volume_sol AS totalVolumeSol, total_pnl_sol AS totalPnlSol, tokens_traded AS tokensTraded, total_buys AS totalBuys, total_sells AS totalSells, first_seen AS firstSeen, last_updated_at AS lastUpdatedAt
     FROM wallet_stats
     ORDER BY total_pnl_sol DESC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as WalletStatsRow[];

  const topWalletTokenStats = db.prepare(
    `SELECT address, mint, buys, sells, volume_sol AS volumeSol, pnl_sol AS pnlSol, pnl_percent AS pnlPercent, is_fresh AS isFresh, is_wash AS isWash, bundle_id AS bundleId, updated_at AS updatedAt
     FROM wallet_token_stats
     ORDER BY pnl_sol DESC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as WalletTokenStatRow[];

  const analyzedMints = db.prepare(
    `SELECT mint, first_analyzed_at AS firstAnalyzedAt, last_analyzed_at AS lastAnalyzedAt, analyses_count AS analysesCount, total_volume_sol AS totalVolumeSol, total_trades AS totalTrades, unique_wallets AS uniqueWallets, dev_address AS devAddress, period_start AS periodStart, period_end AS periodEnd
     FROM analyzed_mints
     ORDER BY last_analyzed_at DESC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as AnalyzedMintRow[];

  const devWalletsTokens = listTopDevWallets("tokens", DISPLAY_LIMIT);
  const devWalletsMigration = listTopDevWallets("migration", DISPLAY_LIMIT);
  const devWallets300k = listTopDevWallets("300k", DISPLAY_LIMIT);

  const devTokens = db.prepare(
    `SELECT mint, creator, symbol, name, created_at AS createdAt, market_cap_usd AS marketCapUsd, ath_usd AS athUsd, is_migrated AS isMigrated, reached_300k AS reached300k, source, last_updated_at AS lastUpdatedAt
     FROM dev_tokens
     ORDER BY COALESCE(ath_usd, market_cap_usd) DESC, last_updated_at DESC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as DatabaseDashboardData["devTokens"];

  const devForensics = db.prepare(
    `SELECT creator, source_mint AS sourceMint, total_created_tokens AS totalCreatedTokens, total_migrated_tokens AS totalMigratedTokens, migration_rate AS migrationRate, avg_lifespan_minutes AS avgLifespanMinutes, success_rate AS successRate, analyzed_at AS analyzedAt
     FROM dev_forensics_analyses
     ORDER BY analyzed_at DESC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as DevForensicsSummaryRow[];

  const apifyRuns = db.prepare(
    `SELECT run_id AS runId, actor_id AS actorId, actor_type AS actorType, status, default_dataset_id AS defaultDatasetId, started_at AS startedAt, finished_at AS finishedAt, input_json AS inputJson, meta_json AS metaJson, last_synced_at AS lastSyncedAt
     FROM apify_runs
     ORDER BY started_at DESC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as ApifyRunSummaryRow[];

  const apifySyncEvents = db.prepare(
    `SELECT source, run_id AS runId, dataset_id AS datasetId, status, imported_items AS importedItems, imported_creators AS importedCreators, imported_tokens AS importedTokens, message, created_at AS createdAt
     FROM apify_sync_events
     ORDER BY created_at DESC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as ApifySyncEventSummaryRow[];

  const marketStatus: MarketCollectorStatus = getMarketCollectorStatus();
  const marketAgg: MarketOverview24h = getMarketOverviewAggregate(Date.now() - MARKET_WINDOW_MS);
  const totalRows = tableCounts.reduce((sum, row) => sum + (row.rows ?? 0), 0);

  return {
    integrity: db.pragma("integrity_check", { simple: true }) as string,
    foreignKeyViolations: db.pragma("foreign_key_check") as unknown[],
    dbPath: DB_PATH,
    totalRows,
    tableCounts,
    migrationKinds,
    recentImports,
    recentTokens,
    recentWallets,
    topMigrationTokens,
    topMigrationWallets,
    worstMigrationWallets,
    topCreators,
    topWalletStats,
    topWalletTokenStats,
    analyzedMints,
    devWalletsTokens,
    devWalletsMigration,
    devWallets300k,
    devTokens,
    devForensics,
    apifyRuns,
    apifySyncEvents,
    marketStatus,
    marketAgg,
  } satisfies DatabaseDashboardData;
}

let dashboardCache: {
  signature: string;
  fetchedAt: number;
  data: DatabaseDashboardData;
} | null = null;

export function getDatabaseDashboardData() {
  const signature = getDashboardSignature();
  const now = Date.now();

  if (dashboardCache && dashboardCache.signature === signature && now - dashboardCache.fetchedAt < DASHBOARD_CACHE_TTL_MS) {
    return dashboardCache.data;
  }

  const data = buildDatabaseDashboard();
  dashboardCache = {
    signature,
    fetchedAt: now,
    data,
  };
  return data;
}
