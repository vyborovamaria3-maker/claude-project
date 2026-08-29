import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  getDb,
  getMarketCollectorStatus,
  getMarketOverviewAggregate,
  listRecentMarketEvents,
  listRecentTokenTrades,
  listMigrationTokenRows,
  listMigrationWalletRows,
  listMigrationXlsxFiles,
  listTopDevWallets,
  type DevWalletRow,
} from "@/lib/trade/db";
import { buildDatabaseAnalytics, DEFAULT_DATABASE_ANALYTICS_FILTERS, type DatabaseAnalytics } from "@/lib/database-analytics";

const DB_PATH = path.join(process.cwd(), "data", "trade.db");
const BACKEND_DB_PATH_CANDIDATES = [
  process.env.BACKEND_DATABASE_PATH,
  path.join(process.cwd(), "data", "dev-backend.db"),
  path.join(process.cwd(), "backend", "data", "dev-backend.db"),
].filter((value): value is string => Boolean(value));
const DISPLAY_LIMIT = 15;
const MARKET_WINDOW_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_CACHE_TTL_MS = 60_000;
const HEAVY_COUNT_TABLES = new Set([
  "migration_token_rows",
  "migration_wallet_rows",
  "token_trades",
  "wallet_token_stats",
  "twitter_accounts",
  "twitter_token_analyses",
  "twitter_token_shillers",
  "twitter_token_tweets",
]);

type Db = ReturnType<typeof getDb>;
type TableCount = { table: string; rows: number | null };
type WorkbookKindRow = { workbookKind: string; files: number; tokenRows: number; walletRows: number };
type RecentImportRow = { fileName: string; workbookKind: string; sheetCount: number; totalRows: number; tokenRows: number; walletRows: number; importedAt: number };
type RecentTokenRow = { fileName: string; sheetName: string; tokenAddress: string; ticker: string | null; creator: string | null; currentMc: number | null; marketCapMax: number | null; totalUniqueBuyers: number | null };
type RecentWalletRow = { fileName: string; sheetName: string; rowIndex: number; wallet: string; pnl: number | null; roi: number | null; totalTokens: number | null; migratedTokens: number | null };
type CreatorRow = { creator: string; tokens: number; migrated: number; avgMcap: number | null };
type WalletStatsRow = { address: string; totalVolumeSol: number; totalPnlSol: number; tokensTraded: number; totalBuys: number; totalSells: number; firstSeen: number; lastUpdatedAt: number };
type WalletTokenStatRow = { address: string; mint: string; buys: number; sells: number; volumeSol: number; pnlSol: number; pnlPercent: number; isFresh: number | boolean; isWash: number | boolean; bundleId: string | null; updatedAt: number };
type AnalyzedMintRow = { mint: string; firstAnalyzedAt: number; lastAnalyzedAt: number; analysesCount: number; totalVolumeSol: number | null; totalTrades: number | null; uniqueWallets: number | null; devAddress: string | null; periodStart: number | null; periodEnd: number | null };
type ApifyRunSummaryRow = { runId: string; actorId: string; actorType: string; status: string; defaultDatasetId: string | null; startedAt: number; finishedAt: number | null; inputJson: string | null; metaJson: string | null; lastSyncedAt: number };
type ApifySyncEventSummaryRow = { source: string; runId: string | null; datasetId: string | null; status: string; importedItems: number; importedCreators: number; importedTokens: number; message: string | null; createdAt: number };
type DevForensicsSummaryRow = { creator: string; sourceMint: string | null; totalCreatedTokens: number; totalMigratedTokens: number; migrationRate: number; avgLifespanMinutes: number | null; successRate: number; analyzedAt: number };
type TwitterAnalysisRow = {
  id: number;
  mint: string | null;
  symbol: string | null;
  tokenTwitterHandle: string | null;
  totalTweets: number;
  totalViews: number;
  totalLikes: number;
  totalRetweets: number;
  uniqueAccounts: number;
  verifiedAccounts: number;
  botAccounts: number;
  excludedBotAccounts: number;
  avgViews: number | null;
  avgLikes: number | null;
  avgRetweets: number | null;
  botManipulationScore: number;
  botManipulationRisk: string;
  analyzedAt: number;
};
type TwitterAccountRow = {
  handle: string;
  displayName: string | null;
  followers: number | null;
  following: number | null;
  postsCount: number | null;
  isVerified: number | boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  botScore: number;
  isBot: number | boolean;
  isSubscriptionPromoter: number | boolean;
  botReasons: string | null;
};
type TwitterShillerRow = {
  mint: string;
  handle: string;
  tweetsCount: number;
  totalViews: number;
  totalLikes: number;
  totalRetweets: number;
  avgViews: number | null;
  avgLikes: number | null;
  avgRetweets: number | null;
  isVerified: number | boolean;
  isBot: number | boolean;
  isExcluded: number | boolean;
  firstTweetedAt: number | null;
  lastTweetedAt: number | null;
};
type SubscriptionClientRow = {
  id: string;
  telegramId: string | null;
  telegramUsername: string | null;
  login: string | null;
  plan: "monthly";
  purchaseAt: number | null;
  subscriptionExpiresAt: number | null;
  lastLoginAt: number | null;
  lastIp: string | null;
  ipCount: number;
  isActive: boolean;
  daysRemaining: number | null;
  daysSincePurchase: number | null;
  daysSinceLastLogin: number | null;
  status: "active" | "expired" | "expiring" | "unknown";
};
type MarketEventRow = ReturnType<typeof listRecentMarketEvents>[number];
type TokenTradeRow = ReturnType<typeof listRecentTokenTrades>[number];
type MarketCollectorStatus = ReturnType<typeof getMarketCollectorStatus>;
type MarketOverview24h = ReturnType<typeof getMarketOverviewAggregate>;

type DatabaseDashboardDataInternal = {
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
  topMigrationWallets: RecentWalletRow[];
  worstMigrationWallets: RecentWalletRow[];
  topCreators: CreatorRow[];
  topWalletStats: WalletStatsRow[];
  topWalletTokenStats: WalletTokenStatRow[];
  analyzedMints: AnalyzedMintRow[];
  devWalletsTokens: DevWalletRow[];
  devWalletsMigration: DevWalletRow[];
  devWallets300k: DevWalletRow[];
  devTokens: Array<{ mint: string; creator: string; symbol: string | null; name: string | null; athUsd: number | null; marketCapUsd: number | null; reached300k: boolean }>;
  devForensics: DevForensicsSummaryRow[];
  twitterAnalyses: TwitterAnalysisRow[];
  twitterAccounts: TwitterAccountRow[];
  twitterShillers: TwitterShillerRow[];
  twitterSummary: {
    totalAnalyses: number;
    riskyAnalyses: number;
    totalTweets: number;
    totalViews: number;
    totalAccounts: number;
    botAccounts: number;
    promoterAccounts: number;
  };
  analytics: DatabaseAnalytics;
  apifyRuns: ApifyRunSummaryRow[];
  apifySyncEvents: ApifySyncEventSummaryRow[];
  subscriptionClients: SubscriptionClientRow[];
  recentMarketEvents: MarketEventRow[];
  recentTokenTrades: TokenTradeRow[];
  subscriptionSummary: {
    totalSubscribers: number;
    activeSubscribers: number;
    expiredSubscribers: number;
    expiringSoonSubscribers: number;
  };
  marketStatus: MarketCollectorStatus;
  marketAgg: MarketOverview24h;
};

export type DatabaseDashboardData = DatabaseDashboardDataInternal;

let dashboardCache: { signature: string; fetchedAt: number; data: DatabaseDashboardData } | null = null;

function resolveBackendDbPath() {
  for (const candidate of BACKEND_DB_PATH_CANDIDATES) {
    if (fs.existsSync(/* turbopackIgnore: true */ candidate)) {
      return candidate;
    }
  }
  return BACKEND_DB_PATH_CANDIDATES[0] ?? "";
}

function getDashboardSignature() {
  try {
    const tradeStat = fs.statSync(DB_PATH);
    const backendDbPath = resolveBackendDbPath();
    const backendStat = backendDbPath ? fs.statSync(/* turbopackIgnore: true */ backendDbPath) : null;
    return `${tradeStat.size}:${tradeStat.mtimeMs}|${backendStat ? `${backendStat.size}:${backendStat.mtimeMs}` : "missing"}`;
  } catch {
    return "missing";
  }
}

function parseSqliteDate(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value !== "string") return null;

  const normalized = value.trim().replace(" ", "T");
  const withMillis = normalized.replace(/\.(\d{3})\d+Z?$/, ".$1Z");
  const withZone = /Z$/.test(withMillis) ? withMillis : `${withMillis}Z`;
  const parsed = Date.parse(withZone);
  return Number.isFinite(parsed) ? parsed : null;
}

function readSubscriptionClients(): {
  subscriptionClients: SubscriptionClientRow[];
  subscriptionSummary: DatabaseDashboardDataInternal["subscriptionSummary"];
} {
  const backendDbPath = resolveBackendDbPath();
  if (!backendDbPath || !fs.existsSync(/* turbopackIgnore: true */ backendDbPath)) {
    return {
      subscriptionClients: [],
      subscriptionSummary: {
        totalSubscribers: 0,
        activeSubscribers: 0,
        expiredSubscribers: 0,
        expiringSoonSubscribers: 0,
      },
    };
  }

  const backendDb = new Database(backendDbPath, { readonly: true, fileMustExist: true });
  try {
    const now = Date.now();
    const rows = backendDb.prepare(
      `SELECT
         id,
         telegram_id AS telegramId,
         telegram_username AS telegramUsername,
         email AS login,
         created_at AS createdAt,
         subscription_expires_at AS subscriptionExpiresAt,
         last_login_at AS lastLoginAt,
         last_ip AS lastIp,
         ip_addresses AS ipAddresses,
         is_active AS isActive
       FROM users
       WHERE subscription_expires_at IS NOT NULL
       ORDER BY COALESCE(subscription_expires_at, created_at) DESC, created_at DESC
       LIMIT ?`
    ).all(DISPLAY_LIMIT) as Array<{
      id: string;
      telegramId: string | null;
      telegramUsername: string | null;
      login: string | null;
      createdAt: string | number | null;
      subscriptionExpiresAt: string | number | null;
      lastLoginAt: string | number | null;
      lastIp: string | null;
      ipAddresses: string | null;
      isActive: number | boolean;
    }>;

    const subscriptionClients = rows.map((row) => {
      const purchaseAt = parseSqliteDate(row.createdAt);
      const expiresAt = parseSqliteDate(row.subscriptionExpiresAt);
      const lastLoginAt = parseSqliteDate(row.lastLoginAt);
      const daysRemaining = expiresAt === null ? null : Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000));
      const daysSincePurchase = purchaseAt === null ? null : Math.max(0, Math.floor((now - purchaseAt) / (24 * 60 * 60 * 1000)));
      const daysSinceLastLogin = lastLoginAt === null ? null : Math.max(0, Math.floor((now - lastLoginAt) / (24 * 60 * 60 * 1000)));
      const status: SubscriptionClientRow["status"] =
        expiresAt === null
          ? "unknown"
          : daysRemaining !== null && daysRemaining < 0
            ? "expired"
            : daysRemaining !== null && daysRemaining <= 7
              ? "expiring"
              : "active";

      let ipCount = 0;
      if (row.ipAddresses) {
        try {
          const parsed = JSON.parse(row.ipAddresses) as unknown;
          if (Array.isArray(parsed)) {
            ipCount = parsed.length;
          }
        } catch {
          ipCount = 0;
        }
      }

      return {
        id: row.id,
        telegramId: row.telegramId,
        telegramUsername: row.telegramUsername,
        login: row.login,
        plan: "monthly" as const,
        purchaseAt,
        subscriptionExpiresAt: expiresAt,
        lastLoginAt,
        lastIp: row.lastIp,
        ipCount,
        isActive: Boolean(row.isActive),
        daysRemaining,
        daysSincePurchase,
        daysSinceLastLogin,
        status,
      };
    });

    const summaryRow = backendDb.prepare(
      `SELECT
         COUNT(*) AS totalSubscribers,
         SUM(CASE WHEN subscription_expires_at IS NOT NULL AND subscription_expires_at >= CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS activeSubscribers,
         SUM(CASE WHEN subscription_expires_at IS NOT NULL AND subscription_expires_at < CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS expiredSubscribers,
         SUM(CASE WHEN subscription_expires_at IS NOT NULL AND subscription_expires_at >= CURRENT_TIMESTAMP AND subscription_expires_at <= datetime(CURRENT_TIMESTAMP, '+7 days') THEN 1 ELSE 0 END) AS expiringSoonSubscribers
       FROM users
       WHERE subscription_expires_at IS NOT NULL`
    ).get() as {
      totalSubscribers: number;
      activeSubscribers: number | null;
      expiredSubscribers: number | null;
      expiringSoonSubscribers: number | null;
    };

    return {
      subscriptionClients,
      subscriptionSummary: {
        totalSubscribers: summaryRow.totalSubscribers ?? 0,
        activeSubscribers: summaryRow.activeSubscribers ?? 0,
        expiredSubscribers: summaryRow.expiredSubscribers ?? 0,
        expiringSoonSubscribers: summaryRow.expiringSoonSubscribers ?? 0,
      },
    };
  } finally {
    backendDb.close();
  }
}

function countRows(db: Db, tableName: string): number | null {
  const sql = HEAVY_COUNT_TABLES.has(tableName)
    ? `SELECT MAX(rowid) AS c FROM ${tableName}`
    : `SELECT COUNT(*) AS c FROM ${tableName}`;
  const row = db.prepare(sql).get() as { c: number | null };
  return row.c;
}

function buildDatabaseDashboard(signature: string): DatabaseDashboardData {
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
    rowIndex: row.rowIndex,
    wallet: row.wallet,
    pnl: row.pnl,
    roi: row.roi,
    totalTokens: row.totalTokens,
    migratedTokens: row.migratedTokens,
  })) as RecentWalletRow[];

  const topMigrationTokens = db.prepare(
    `SELECT file_name AS fileName, sheet_name AS sheetName, token_address AS tokenAddress, ticker, creator, current_mc AS currentMc, market_cap_max AS marketCapMax, total_unique_buyers AS totalUniqueBuyers
     FROM migration_token_rows
     ORDER BY market_cap_max DESC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as RecentTokenRow[];

  const topMigrationWallets = db.prepare(
    `SELECT file_name AS fileName, sheet_name AS sheetName, row_index AS rowIndex, wallet, pnl, roi, total_tokens AS totalTokens, migrated_tokens AS migratedTokens
     FROM migration_wallet_rows
     ORDER BY pnl DESC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as RecentWalletRow[];

  const worstMigrationWallets = db.prepare(
    `SELECT file_name AS fileName, sheet_name AS sheetName, row_index AS rowIndex, wallet, pnl, roi, total_tokens AS totalTokens, migrated_tokens AS migratedTokens
     FROM migration_wallet_rows
     ORDER BY pnl ASC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as RecentWalletRow[];

  const topCreators = db.prepare(
    `SELECT creator, COUNT(*) AS tokens, SUM(is_migrated) AS migrated, AVG(market_cap_usd) AS avgMcap
     FROM dev_tokens
     GROUP BY creator
     ORDER BY tokens DESC
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

  const devWalletsTokens = listTopDevWallets("tokens", DISPLAY_LIMIT) as DevWalletRow[];
  const devWalletsMigration = listTopDevWallets("migration", DISPLAY_LIMIT) as DevWalletRow[];
  const devWallets300k = listTopDevWallets("300k", DISPLAY_LIMIT) as DevWalletRow[];

  const devTokens = db.prepare(
    `SELECT mint, creator, symbol, name, ath_usd AS athUsd, market_cap_usd AS marketCapUsd, reached_300k AS reached300k
     FROM dev_tokens
     ORDER BY ath_usd DESC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as DatabaseDashboardDataInternal["devTokens"];

  const devForensics = db.prepare(
    `SELECT creator, source_mint AS sourceMint, total_created_tokens AS totalCreatedTokens, total_migrated_tokens AS totalMigratedTokens, migration_rate AS migrationRate, avg_lifespan_minutes AS avgLifespanMinutes, success_rate AS successRate, analyzed_at AS analyzedAt
     FROM dev_forensics_analyses
     ORDER BY analyzed_at DESC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as DevForensicsSummaryRow[];

  const twitterAnalyses = db.prepare(
    `SELECT id, mint, symbol, token_twitter_handle AS tokenTwitterHandle, total_tweets AS totalTweets, total_views AS totalViews, total_likes AS totalLikes, total_retweets AS totalRetweets, unique_accounts AS uniqueAccounts, verified_accounts AS verifiedAccounts, bot_accounts AS botAccounts, excluded_bot_accounts AS excludedBotAccounts, avg_views AS avgViews, avg_likes AS avgLikes, avg_retweets AS avgRetweets, bot_manipulation_score AS botManipulationScore, bot_manipulation_risk AS botManipulationRisk, analyzed_at AS analyzedAt
     FROM twitter_token_analyses
     ORDER BY analyzed_at DESC, bot_manipulation_score DESC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as TwitterAnalysisRow[];

  const twitterAccounts = db.prepare(
    `SELECT handle, display_name AS displayName, followers, following, posts_count AS postsCount, is_verified AS isVerified, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, bot_score AS botScore, is_bot AS isBot, is_subscription_promoter AS isSubscriptionPromoter, bot_reasons AS botReasons
     FROM twitter_accounts
     ORDER BY bot_score DESC, last_seen_at DESC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as TwitterAccountRow[];

  const twitterShillers = db.prepare(
    `SELECT mint, handle, tweets_count AS tweetsCount, total_views AS totalViews, total_likes AS totalLikes, total_retweets AS totalRetweets, avg_views AS avgViews, avg_likes AS avgLikes, avg_retweets AS avgRetweets, is_verified AS isVerified, is_bot AS isBot, is_excluded AS isExcluded, first_tweeted_at AS firstTweetedAt, last_tweeted_at AS lastTweetedAt
     FROM twitter_token_shillers
     ORDER BY total_views DESC, tweets_count DESC
     LIMIT ?`
  ).all(DISPLAY_LIMIT) as TwitterShillerRow[];

  const twitterSummaryRow = db.prepare(
    `SELECT
       COUNT(*) AS totalAnalyses,
       SUM(CASE WHEN bot_manipulation_risk IN ('medium', 'high') THEN 1 ELSE 0 END) AS riskyAnalyses,
       COALESCE(SUM(total_tweets), 0) AS totalTweets,
       COALESCE(SUM(total_views), 0) AS totalViews
     FROM twitter_token_analyses`
  ).get() as {
    totalAnalyses: number;
    riskyAnalyses: number | null;
    totalTweets: number | null;
    totalViews: number | null;
  };

  const twitterAccountSummaryRow = db.prepare(
    `SELECT
       COUNT(*) AS totalAccounts,
       SUM(CASE WHEN is_bot = 1 THEN 1 ELSE 0 END) AS botAccounts,
       SUM(CASE WHEN is_subscription_promoter = 1 THEN 1 ELSE 0 END) AS promoterAccounts
     FROM twitter_accounts`
  ).get() as {
    totalAccounts: number;
    botAccounts: number | null;
    promoterAccounts: number | null;
  };

  const analytics = buildDatabaseAnalytics(DEFAULT_DATABASE_ANALYTICS_FILTERS, signature);

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

  const recentMarketEvents = listRecentMarketEvents(DISPLAY_LIMIT);
  const recentTokenTrades = listRecentTokenTrades(DISPLAY_LIMIT);
  const { subscriptionClients, subscriptionSummary } = readSubscriptionClients();
  const marketStatus: MarketCollectorStatus = getMarketCollectorStatus();
  const marketAgg: MarketOverview24h = getMarketOverviewAggregate(Date.now() - MARKET_WINDOW_MS);

  const totalRows = tableCounts.reduce((sum, row) => sum + (row.rows ?? 0), 0);
  const runAudit = process.env.DATABASE_AUDIT_ON_STARTUP === "1";

  return {
    integrity: runAudit ? (db.pragma("integrity_check", { simple: true }) as string) : "skipped",
    foreignKeyViolations: runAudit ? (db.pragma("foreign_key_check") as unknown[]) : [],
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
    twitterAnalyses,
    twitterAccounts,
    twitterShillers,
    twitterSummary: {
      totalAnalyses: twitterSummaryRow.totalAnalyses ?? 0,
      riskyAnalyses: twitterSummaryRow.riskyAnalyses ?? 0,
      totalTweets: twitterSummaryRow.totalTweets ?? 0,
      totalViews: twitterSummaryRow.totalViews ?? 0,
      totalAccounts: twitterAccountSummaryRow.totalAccounts ?? 0,
      botAccounts: twitterAccountSummaryRow.botAccounts ?? 0,
      promoterAccounts: twitterAccountSummaryRow.promoterAccounts ?? 0,
    },
    analytics,
    apifyRuns,
    apifySyncEvents,
    subscriptionClients,
    recentMarketEvents,
    recentTokenTrades,
    subscriptionSummary,
    marketStatus,
    marketAgg,
  };
}

export function getDatabaseDashboard(): DatabaseDashboardData {
  const signature = getDashboardSignature();
  const now = Date.now();

  if (dashboardCache && dashboardCache.signature === signature && now - dashboardCache.fetchedAt < DASHBOARD_CACHE_TTL_MS) {
    return dashboardCache.data;
  }

  const data = buildDatabaseDashboard(signature);
  dashboardCache = {
    signature,
    fetchedAt: now,
    data,
  };
  return data;
}
