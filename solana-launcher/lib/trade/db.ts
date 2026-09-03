// data-tag: lib.trade.db
// SQLite store for: dev tags (subscriptions), analysis cache, wallet-level cache
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "trade.db");

// Singleton — Next.js dev hot-reload friendly
declare global {
  // eslint-disable-next-line no-var
  var __TRADE_DB__: Database.Database | undefined;
}

function init(db: Database.Database) {

  // ── Migration: extend TTL of pre-existing analysis_cache rows to 24h ──
  // Older entries were created with 5min TTL which made every page reload
  // re-analyze. Bump them to 24h once so existing analyses stay cached.
  try {
    db.prepare(
      `UPDATE analysis_cache SET ttl_ms = 86400000 WHERE ttl_ms < 86400000`
    ).run();
  } catch {
    // Table may not exist on first run — ignore
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_tags (
      address TEXT PRIMARY KEY,
      tag TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS analysis_cache (
      mint TEXT PRIMARY KEY,
      payload TEXT NOT NULL,         -- JSON blob
      fetched_at INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL DEFAULT 300000  -- 5 min
    );

    CREATE TABLE IF NOT EXISTS wallet_profile_cache (
      address TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL DEFAULT 600000  -- 10 min
    );

    CREATE TABLE IF NOT EXISTS dev_tokens_cache (
      dev_address TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL DEFAULT 1800000  -- 30 min
    );

    CREATE INDEX IF NOT EXISTS idx_analysis_fetched ON analysis_cache(fetched_at);
    CREATE INDEX IF NOT EXISTS idx_wallet_fetched ON wallet_profile_cache(fetched_at);

    -- ── Persistent history (no TTL) ────────────────────────────
    -- Every mint that was ever analyzed (summary snapshot, kept forever)
    CREATE TABLE IF NOT EXISTS analyzed_mints (
      mint TEXT PRIMARY KEY,
      first_analyzed_at INTEGER NOT NULL,
      last_analyzed_at  INTEGER NOT NULL,
      analyses_count    INTEGER NOT NULL DEFAULT 1,
      total_volume_sol  REAL,
      total_trades      INTEGER,
      unique_wallets    INTEGER,
      dev_address       TEXT,
      period_start      INTEGER,
      period_end        INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mints_last ON analyzed_mints(last_analyzed_at DESC);

    -- Per-wallet aggregated stats across ALL analyzed tokens (rebuilt on each analysis)
    CREATE TABLE IF NOT EXISTS wallet_stats (
      address           TEXT PRIMARY KEY,
      total_volume_sol  REAL NOT NULL DEFAULT 0,
      total_pnl_sol     REAL NOT NULL DEFAULT 0,
      tokens_traded     INTEGER NOT NULL DEFAULT 0,
      total_buys        INTEGER NOT NULL DEFAULT 0,
      total_sells       INTEGER NOT NULL DEFAULT 0,
      first_seen        INTEGER,
      last_updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_stats_pnl ON wallet_stats(total_pnl_sol DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_stats_vol ON wallet_stats(total_volume_sol DESC);

    -- Per-wallet-per-token snapshot (composite PK)
    CREATE TABLE IF NOT EXISTS wallet_token_stats (
      address      TEXT NOT NULL,
      mint         TEXT NOT NULL,
      buys         INTEGER NOT NULL DEFAULT 0,
      sells        INTEGER NOT NULL DEFAULT 0,
      volume_sol   REAL NOT NULL DEFAULT 0,
      pnl_sol      REAL NOT NULL DEFAULT 0,
      pnl_percent  REAL NOT NULL DEFAULT 0,
      is_fresh     INTEGER NOT NULL DEFAULT 0,
      is_wash      INTEGER NOT NULL DEFAULT 0,
      bundle_id    TEXT,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (address, mint)
    );
    CREATE INDEX IF NOT EXISTS idx_wts_addr ON wallet_token_stats(address);
    CREATE INDEX IF NOT EXISTS idx_wts_mint ON wallet_token_stats(mint);
    CREATE INDEX IF NOT EXISTS idx_wts_pnl  ON wallet_token_stats(pnl_sol DESC);

    CREATE TABLE IF NOT EXISTS token_trades (
      mint           TEXT NOT NULL,
      signature      TEXT NOT NULL,
      timestamp      INTEGER NOT NULL,
      trader         TEXT NOT NULL,
      type           TEXT NOT NULL,
      amount_sol     REAL NOT NULL,
      amount_tokens  REAL NOT NULL,
      price_sol      REAL NOT NULL,
      source         TEXT,
      inserted_at    INTEGER NOT NULL,
      PRIMARY KEY (mint, signature)
    );
    CREATE INDEX IF NOT EXISTS idx_token_trades_mint_ts ON token_trades(mint, timestamp);
    CREATE INDEX IF NOT EXISTS idx_token_trades_mint_trader ON token_trades(mint, trader);

    -- ── Dev (creator) wallet profiles ─────────────────────────
    -- One row per creator wallet, refreshed each time we fetch their tokens.
    CREATE TABLE IF NOT EXISTS dev_wallets (
      address             TEXT PRIMARY KEY,
      -- pump.fun stats
      total_tokens        INTEGER NOT NULL DEFAULT 0,
      migrated_count      INTEGER NOT NULL DEFAULT 0,
      migration_rate      REAL    NOT NULL DEFAULT 0,
      reached_300k_count  INTEGER NOT NULL DEFAULT 0,
      rate_300k           REAL    NOT NULL DEFAULT 0,
      best_launch_hour    INTEGER,              -- UTC hour 0-23, NULL if not enough data
      -- aggregated across all tokens
      total_volume_sol    REAL    NOT NULL DEFAULT 0,
      total_fees_sol      REAL    NOT NULL DEFAULT 0,
      avg_mc_usd          REAL,
      max_mc_usd          REAL,
      -- source
      source              TEXT    NOT NULL DEFAULT 'pumpfun',  -- 'pumpfun'|'das'
      first_seen_at       INTEGER NOT NULL,
      last_updated_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dev_wallets_updated   ON dev_wallets(last_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dev_wallets_migration ON dev_wallets(migration_rate DESC);
    CREATE INDEX IF NOT EXISTS idx_dev_wallets_tokens    ON dev_wallets(total_tokens DESC);

    -- ── Individual tokens created by each dev ─────────────────
    -- One row per (creator, mint). Upserted on every analyzeDev call.
    CREATE TABLE IF NOT EXISTS dev_tokens (
      mint                TEXT    NOT NULL,
      creator             TEXT    NOT NULL,
      symbol              TEXT,
      name                TEXT,
      image               TEXT,
      description         TEXT,
      twitter             TEXT,
      telegram            TEXT,
      website             TEXT,
      created_at          INTEGER,              -- unix sec, pump.fun creation timestamp
      market_cap_usd      REAL,
      ath_usd             REAL,
      is_migrated         INTEGER NOT NULL DEFAULT 0,  -- 0/1
      reached_300k        INTEGER NOT NULL DEFAULT 0,  -- 0/1
      total_supply        INTEGER,
      token_volume_sol    REAL,                  -- cached total trading volume in SOL
      token_volume_usd    REAL,                  -- cached total trading volume in USD
      source              TEXT    NOT NULL DEFAULT 'pumpfun',
      last_updated_at     INTEGER NOT NULL,
      PRIMARY KEY (mint, creator)
    );
    CREATE INDEX IF NOT EXISTS idx_dev_tokens_creator  ON dev_tokens(creator);
    CREATE INDEX IF NOT EXISTS idx_dev_tokens_created  ON dev_tokens(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dev_tokens_mc       ON dev_tokens(market_cap_usd DESC);
    CREATE INDEX IF NOT EXISTS idx_dev_tokens_migrated ON dev_tokens(is_migrated);

    CREATE TABLE IF NOT EXISTS dev_forensics_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator TEXT NOT NULL,
      source_mint TEXT,
      payload TEXT NOT NULL,
      total_created_tokens INTEGER NOT NULL DEFAULT 0,
      total_migrated_tokens INTEGER NOT NULL DEFAULT 0,
      migration_rate REAL NOT NULL DEFAULT 0,
      avg_lifespan_minutes REAL,
      success_rate REAL NOT NULL DEFAULT 0,
      analyzed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dev_forensics_creator ON dev_forensics_analyses(creator, analyzed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dev_forensics_mint ON dev_forensics_analyses(source_mint, analyzed_at DESC);

    CREATE TABLE IF NOT EXISTS apify_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      actor_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      status TEXT NOT NULL,
      default_dataset_id TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      input_json TEXT,
      meta_json TEXT,
      last_synced_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_apify_runs_type_started ON apify_runs(actor_type, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_apify_runs_status ON apify_runs(status, last_synced_at DESC);

    CREATE TABLE IF NOT EXISTS apify_sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      run_id TEXT,
      dataset_id TEXT,
      status TEXT NOT NULL,
      imported_items INTEGER NOT NULL DEFAULT 0,
      imported_creators INTEGER NOT NULL DEFAULT 0,
      imported_tokens INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      meta_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_apify_sync_events_source_created ON apify_sync_events(source, created_at DESC);

    CREATE TABLE IF NOT EXISTS market_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      mint TEXT,
      trader TEXT,
      tx_type TEXT,
      amount_sol REAL NOT NULL DEFAULT 0,
      market_cap_sol REAL,
      payload_json TEXT,
      source TEXT NOT NULL,
      observed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_market_events_kind_time ON market_events(kind, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_market_events_mint_time ON market_events(mint, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_market_events_trader_time ON market_events(trader, observed_at DESC);

    CREATE TABLE IF NOT EXISTS migration_xlsx_files (
      file_path TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      workbook_kind TEXT NOT NULL,
      sheet_count INTEGER NOT NULL DEFAULT 0,
      total_rows INTEGER NOT NULL DEFAULT 0,
      token_rows INTEGER NOT NULL DEFAULT 0,
      wallet_rows INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT,
      imported_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_migration_xlsx_kind ON migration_xlsx_files(workbook_kind, imported_at DESC);

    CREATE TABLE IF NOT EXISTS migration_token_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      row_index INTEGER NOT NULL,
      token_address TEXT NOT NULL,
      ticker TEXT,
      total_unique_buyers INTEGER,
      current_mc REAL,
      market_cap_max REAL,
      mint_time_text TEXT,
      migration_time_text TEXT,
      time_before_migration_text TEXT,
      time_before_migration_seconds INTEGER,
      creator TEXT,
      creator_source TEXT,
      raw_json TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      UNIQUE(file_path, sheet_name, row_index)
    );
    CREATE INDEX IF NOT EXISTS idx_migration_token_address ON migration_token_rows(token_address);
    CREATE INDEX IF NOT EXISTS idx_migration_token_creator ON migration_token_rows(creator);
    CREATE INDEX IF NOT EXISTS idx_migration_token_file ON migration_token_rows(file_path, sheet_name);

    CREATE TABLE IF NOT EXISTS migration_wallet_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      row_index INTEGER NOT NULL,
      wallet TEXT NOT NULL,
      wr REAL,
      roi REAL,
      pnl REAL,
      rockets INTEGER,
      median_roi REAL,
      avg_roi REAL,
      fast_trades INTEGER,
      fast_trades_pct REAL,
      balance REAL,
      total_tokens INTEGER,
      sold_gt_bought INTEGER,
      sold_gt_bought_pct REAL,
      avg_trade_duration_text TEXT,
      pf_tokens INTEGER,
      pf_trades_pct REAL,
      avg_buy_sol REAL,
      median_sol_buy REAL,
      avg_mcap_first_tx TEXT,
      avg_mcap_last_tx TEXT,
      last_trade_text TEXT,
      last_trade_hour INTEGER,
      migrated_tokens INTEGER,
      migrated_pct REAL,
      raw_json TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      UNIQUE(file_path, sheet_name, row_index)
    );
    CREATE INDEX IF NOT EXISTS idx_migration_wallet_wallet ON migration_wallet_rows(wallet);
    CREATE INDEX IF NOT EXISTS idx_migration_wallet_pnl ON migration_wallet_rows(pnl DESC);
    CREATE INDEX IF NOT EXISTS idx_migration_wallet_file ON migration_wallet_rows(file_path, sheet_name);

    CREATE TABLE IF NOT EXISTS wallet_tags (
      wallet TEXT NOT NULL,
      tag TEXT NOT NULL,
      score REAL,
      reason TEXT,
      reports INTEGER NOT NULL DEFAULT 0,
      avg_pnl REAL,
      avg_roi REAL,
      avg_wr REAL,
      avg_migrated_pct REAL,
      avg_fast_trades_pct REAL,
      total_rockets INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (wallet, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_tags_tag ON wallet_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_wallet_tags_wallet ON wallet_tags(wallet);
    CREATE INDEX IF NOT EXISTS idx_wallet_tags_score ON wallet_tags(score DESC);

    CREATE TABLE IF NOT EXISTS twitter_token_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT,
      symbol TEXT,
      token_twitter_handle TEXT,
      query TEXT NOT NULL,
      total_tweets INTEGER NOT NULL DEFAULT 0,
      total_views INTEGER NOT NULL DEFAULT 0,
      total_likes INTEGER NOT NULL DEFAULT 0,
      total_retweets INTEGER NOT NULL DEFAULT 0,
      unique_accounts INTEGER NOT NULL DEFAULT 0,
      verified_accounts INTEGER NOT NULL DEFAULT 0,
      bot_accounts INTEGER NOT NULL DEFAULT 0,
      excluded_bot_accounts INTEGER NOT NULL DEFAULT 0,
      avg_views REAL,
      avg_likes REAL,
      avg_retweets REAL,
      bot_manipulation_score REAL NOT NULL DEFAULT 0,
      bot_manipulation_risk TEXT NOT NULL DEFAULT 'low',
      analyzed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_twitter_analyses_mint ON twitter_token_analyses(mint, analyzed_at DESC);

    CREATE TABLE IF NOT EXISTS twitter_token_tweets (
      tweet_id TEXT PRIMARY KEY,
      mint TEXT,
      symbol TEXT,
      author_handle TEXT NOT NULL,
      text TEXT NOT NULL,
      url TEXT,
      views INTEGER NOT NULL DEFAULT 0,
      likes INTEGER NOT NULL DEFAULT 0,
      retweets INTEGER NOT NULL DEFAULT 0,
      replies INTEGER NOT NULL DEFAULT 0,
      is_verified INTEGER NOT NULL DEFAULT 0,
      is_suspicious INTEGER NOT NULL DEFAULT 0,
      suspicion_score REAL NOT NULL DEFAULT 0,
      suspicion_reasons TEXT NOT NULL DEFAULT '[]',
      posted_at INTEGER,
      fetched_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_twitter_tweets_mint ON twitter_token_tweets(mint, fetched_at DESC);

    CREATE TABLE IF NOT EXISTS twitter_accounts (
      handle TEXT PRIMARY KEY,
      display_name TEXT,
      followers INTEGER,
      following INTEGER,
      posts_count INTEGER,
      is_verified INTEGER NOT NULL DEFAULT 0,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      bot_score REAL NOT NULL DEFAULT 0,
      is_bot INTEGER NOT NULL DEFAULT 0,
      is_subscription_promoter INTEGER NOT NULL DEFAULT 0,
      bot_reasons TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_twitter_accounts_bot_score ON twitter_accounts(bot_score DESC);

    CREATE TABLE IF NOT EXISTS twitter_token_shillers (
      mint TEXT NOT NULL,
      handle TEXT NOT NULL,
      tweets_count INTEGER NOT NULL DEFAULT 0,
      total_views INTEGER NOT NULL DEFAULT 0,
      total_likes INTEGER NOT NULL DEFAULT 0,
      total_retweets INTEGER NOT NULL DEFAULT 0,
      avg_views REAL,
      avg_likes REAL,
      avg_retweets REAL,
      is_verified INTEGER NOT NULL DEFAULT 0,
      is_bot INTEGER NOT NULL DEFAULT 0,
      is_excluded INTEGER NOT NULL DEFAULT 0,
      first_tweeted_at INTEGER,
      last_tweeted_at INTEGER,
      PRIMARY KEY (mint, handle)
    );
    CREATE INDEX IF NOT EXISTS idx_twitter_shillers_mint ON twitter_token_shillers(mint, total_views DESC);

    CREATE TABLE IF NOT EXISTS twitter_social_discoveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_type TEXT NOT NULL DEFAULT 'account',
      handle TEXT,
      display_name TEXT,
      url TEXT,
      contract_address TEXT,
      symbol TEXT,
      source_query TEXT NOT NULL,
      matched_in TEXT NOT NULL DEFAULT 'tweet',
      profile_text TEXT,
      tweet_id TEXT,
      tweet_text TEXT,
      tweet_posted_at INTEGER,
      account_created_at INTEGER,
      discovered_at INTEGER NOT NULL,
      followers INTEGER,
      following INTEGER,
      posts_count INTEGER,
      is_verified INTEGER NOT NULL DEFAULT 0,
      is_memecoin INTEGER NOT NULL DEFAULT 0,
      mentions_pumpfun INTEGER NOT NULL DEFAULT 0,
      raw_json TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_twitter_social_unique
      ON twitter_social_discoveries(subject_type, COALESCE(handle, ''), COALESCE(contract_address, ''), COALESCE(tweet_id, ''));
    CREATE INDEX IF NOT EXISTS idx_twitter_social_contract ON twitter_social_discoveries(contract_address, discovered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_twitter_social_created ON twitter_social_discoveries(account_created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_twitter_social_type_created ON twitter_social_discoveries(subject_type, account_created_at DESC);

    CREATE TABLE IF NOT EXISTS database_analytics_snapshots (
      snapshot_key TEXT PRIMARY KEY,
      source_signature TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      computed_at INTEGER NOT NULL
    );
  `);
}

export function getDb(): Database.Database {
  if (!global.__TRADE_DB__) {
    const db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
    db.pragma("cache_size = -32000");   // 32 MB page cache
    db.pragma("foreign_keys = ON");
    db.pragma("temp_store = MEMORY");
    global.__TRADE_DB__ = db;
  }
  // Always run init so new tables are created on hot-reload too
  init(global.__TRADE_DB__);
  return global.__TRADE_DB__;
}

// ── Dev tags ──────────────────────────────────────────────────
export interface DevTag {
  address: string;
  tag: string;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export function upsertDevTag(address: string, tag: string, note?: string): DevTag {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO dev_tags (address, tag, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET tag=excluded.tag, note=excluded.note, updated_at=excluded.updated_at`
  ).run(address, tag, note ?? null, now, now);
  return getDevTag(address)!;
}

export function getDevTag(address: string): DevTag | null {
  const row = getDb()
    .prepare(`SELECT address, tag, note, created_at as createdAt, updated_at as updatedAt FROM dev_tags WHERE address = ?`)
    .get(address) as DevTag | undefined;
  return row ?? null;
}

export function deleteDevTag(address: string): boolean {
  const info = getDb().prepare(`DELETE FROM dev_tags WHERE address = ?`).run(address);
  return info.changes > 0;
}

export function listDevTags(): DevTag[] {
  return getDb()
    .prepare(`SELECT address, tag, note, created_at as createdAt, updated_at as updatedAt FROM dev_tags ORDER BY updated_at DESC`)
    .all() as DevTag[];
}

// ── Cache helpers ─────────────────────────────────────────────
export function getCache<T>(table: "analysis_cache" | "wallet_profile_cache" | "dev_tokens_cache", key: string): T | null {
  const col = table === "analysis_cache" ? "mint" : table === "wallet_profile_cache" ? "address" : "dev_address";
  const row = getDb()
    .prepare(`SELECT payload, fetched_at, ttl_ms FROM ${table} WHERE ${col} = ?`)
    .get(key) as { payload: string; fetched_at: number; ttl_ms: number } | undefined;
  if (!row) return null;
  if (Date.now() - row.fetched_at > row.ttl_ms) return null;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

export function setCache(
  table: "analysis_cache" | "wallet_profile_cache" | "dev_tokens_cache",
  key: string,
  payload: unknown,
  ttlMs?: number
) {
  const col = table === "analysis_cache" ? "mint" : table === "wallet_profile_cache" ? "address" : "dev_address";
  const now = Date.now();
  const json = JSON.stringify(payload);
  const stmt = getDb().prepare(
    ttlMs != null
      ? `INSERT INTO ${table} (${col}, payload, fetched_at, ttl_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT(${col}) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at, ttl_ms=excluded.ttl_ms`
      : `INSERT INTO ${table} (${col}, payload, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(${col}) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at`
  );
  if (ttlMs != null) stmt.run(key, json, now, ttlMs);
  else stmt.run(key, json, now);
}

// ── Persistent: analyzed mints history ───────────────────────
export interface AnalyzedMintRow {
  mint: string;
  firstAnalyzedAt: number;
  lastAnalyzedAt: number;
  analysesCount: number;
  totalVolumeSol: number | null;
  totalTrades: number | null;
  uniqueWallets: number | null;
  devAddress: string | null;
  periodStart: number | null;
  periodEnd: number | null;
}

export function recordAnalyzedMint(snap: {
  mint: string;
  totalVolumeSol?: number;
  totalTrades?: number;
  uniqueWallets?: number;
  devAddress?: string | null;
  periodStart?: number | null;
  periodEnd?: number | null;
}) {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO analyzed_mints
        (mint, first_analyzed_at, last_analyzed_at, analyses_count,
         total_volume_sol, total_trades, unique_wallets, dev_address, period_start, period_end)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mint) DO UPDATE SET
         last_analyzed_at = excluded.last_analyzed_at,
         analyses_count   = analyzed_mints.analyses_count + 1,
         total_volume_sol = excluded.total_volume_sol,
         total_trades     = excluded.total_trades,
         unique_wallets   = excluded.unique_wallets,
         dev_address      = COALESCE(excluded.dev_address, analyzed_mints.dev_address),
         period_start     = COALESCE(excluded.period_start, analyzed_mints.period_start),
         period_end       = excluded.period_end`
    )
    .run(
      snap.mint,
      now,
      now,
      snap.totalVolumeSol ?? null,
      snap.totalTrades ?? null,
      snap.uniqueWallets ?? null,
      snap.devAddress ?? null,
      snap.periodStart ?? null,
      snap.periodEnd ?? null
    );
}

export function listAnalyzedMints(limit = 100): AnalyzedMintRow[] {
  return getDb()
    .prepare(
      `SELECT
         mint,
         first_analyzed_at AS firstAnalyzedAt,
         last_analyzed_at  AS lastAnalyzedAt,
         analyses_count    AS analysesCount,
         total_volume_sol  AS totalVolumeSol,
         total_trades      AS totalTrades,
         unique_wallets    AS uniqueWallets,
         dev_address       AS devAddress,
         period_start      AS periodStart,
         period_end        AS periodEnd
       FROM analyzed_mints
       ORDER BY last_analyzed_at DESC
       LIMIT ?`
    )
    .all(limit) as AnalyzedMintRow[];
}

export interface StoredTokenTrade {
  signature: string;
  timestamp: number;
  trader: string;
  type: "buy" | "sell" | "transfer" | "unknown";
  amountSol: number;
  amountTokens: number;
  priceSol: number;
  source?: string;
}

export function getTokenTrades(mint: string, limit = 10_000): StoredTokenTrade[] {
  return getDb()
    .prepare(
      `SELECT signature, timestamp, trader, type,
              amount_sol AS amountSol, amount_tokens AS amountTokens,
              price_sol AS priceSol, source
       FROM token_trades
       WHERE mint = ?
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(mint, limit)
    .reverse() as StoredTokenTrade[];
}

export function persistTokenTrades(mint: string, trades: StoredTokenTrade[]) {
  if (trades.length === 0) return;
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO token_trades
      (mint, signature, timestamp, trader, type, amount_sol, amount_tokens, price_sol, source, inserted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint, signature) DO UPDATE SET
       timestamp = excluded.timestamp,
       trader = excluded.trader,
       type = excluded.type,
       amount_sol = excluded.amount_sol,
       amount_tokens = excluded.amount_tokens,
       price_sol = excluded.price_sol,
       source = excluded.source`
  );

  const tx = db.transaction((rows: StoredTokenTrade[]) => {
    for (const t of rows) {
      stmt.run(
        mint,
        t.signature,
        t.timestamp,
        t.trader,
        t.type,
        t.amountSol,
        t.amountTokens,
        t.priceSol,
        t.source ?? null,
        now
      );
    }
  });

  tx(trades);
}

// ── Persistent: per-wallet stats ─────────────────────────────
export interface WalletTokenSnapshot {
  address: string;
  mint: string;
  buys: number;
  sells: number;
  volumeSol: number;
  pnlSol: number;
  pnlPercent: number;
  isFresh: boolean;
  isWash: boolean;
  bundleId?: string | null;
  firstSeen?: number | null;
}

/**
 * Atomically upsert wallet_token_stats rows AND rebuild wallet_stats aggregate
 * for the given mint's wallets in a single transaction.
 */
export function persistWalletSnapshots(mint: string, snapshots: WalletTokenSnapshot[]) {
  if (snapshots.length === 0) return;
  const db = getDb();
  const now = Date.now();

  const upsertWts = db.prepare(
    `INSERT INTO wallet_token_stats
       (address, mint, buys, sells, volume_sol, pnl_sol, pnl_percent, is_fresh, is_wash, bundle_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address, mint) DO UPDATE SET
       buys=excluded.buys, sells=excluded.sells, volume_sol=excluded.volume_sol,
       pnl_sol=excluded.pnl_sol, pnl_percent=excluded.pnl_percent,
       is_fresh=excluded.is_fresh, is_wash=excluded.is_wash, bundle_id=excluded.bundle_id,
       updated_at=excluded.updated_at`
  );

  // Aggregate query: re-compute totals from wallet_token_stats for this address
  const aggregate = db.prepare(
    `INSERT INTO wallet_stats (address, total_volume_sol, total_pnl_sol, tokens_traded,
                               total_buys, total_sells, first_seen, last_updated_at)
     SELECT ?, COALESCE(SUM(volume_sol),0), COALESCE(SUM(pnl_sol),0),
            COUNT(DISTINCT mint), COALESCE(SUM(buys),0), COALESCE(SUM(sells),0), ?, ?
     FROM wallet_token_stats WHERE address = ?
     ON CONFLICT(address) DO UPDATE SET
       total_volume_sol = excluded.total_volume_sol,
       total_pnl_sol    = excluded.total_pnl_sol,
       tokens_traded    = excluded.tokens_traded,
       total_buys       = excluded.total_buys,
       total_sells      = excluded.total_sells,
       first_seen       = COALESCE(wallet_stats.first_seen, excluded.first_seen),
       last_updated_at  = excluded.last_updated_at`
  );

  const tx = db.transaction((rows: WalletTokenSnapshot[]) => {
    for (const r of rows) {
      upsertWts.run(
        r.address, r.mint, r.buys, r.sells, r.volumeSol, r.pnlSol, r.pnlPercent,
        r.isFresh ? 1 : 0, r.isWash ? 1 : 0, r.bundleId ?? null, now
      );
      aggregate.run(r.address, r.firstSeen ?? null, now, r.address);
    }
  });
  tx(snapshots);
}

export interface WalletStatsRow {
  address: string;
  totalVolumeSol: number;
  totalPnlSol: number;
  tokensTraded: number;
  totalBuys: number;
  totalSells: number;
  firstSeen: number | null;
  lastUpdatedAt: number;
}

export function getWalletStats(address: string): WalletStatsRow | null {
  const row = getDb()
    .prepare(
      `SELECT address, total_volume_sol AS totalVolumeSol, total_pnl_sol AS totalPnlSol,
              tokens_traded AS tokensTraded, total_buys AS totalBuys, total_sells AS totalSells,
              first_seen AS firstSeen, last_updated_at AS lastUpdatedAt
       FROM wallet_stats WHERE address = ?`
    )
    .get(address) as WalletStatsRow | undefined;
  return row ?? null;
}

export function getWalletStatsBatch(addresses: string[]): Map<string, WalletStatsRow> {
  const out = new Map<string, WalletStatsRow>();
  if (addresses.length === 0) return out;
  const placeholders = addresses.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT address, total_volume_sol AS totalVolumeSol, total_pnl_sol AS totalPnlSol,
              tokens_traded AS tokensTraded, total_buys AS totalBuys, total_sells AS totalSells,
              first_seen AS firstSeen, last_updated_at AS lastUpdatedAt
       FROM wallet_stats WHERE address IN (${placeholders})`
    )
    .all(...addresses) as WalletStatsRow[];
  for (const r of rows) out.set(r.address, r);
  return out;
}

export function listTopWallets(orderBy: "pnl" | "volume" = "pnl", limit = 100): WalletStatsRow[] {
  const col = orderBy === "pnl" ? "total_pnl_sol" : "total_volume_sol";
  return getDb()
    .prepare(
      `SELECT address, total_volume_sol AS totalVolumeSol, total_pnl_sol AS totalPnlSol,
              tokens_traded AS tokensTraded, total_buys AS totalBuys, total_sells AS totalSells,
              first_seen AS firstSeen, last_updated_at AS lastUpdatedAt
       FROM wallet_stats ORDER BY ${col} DESC LIMIT ?`
    )
    .all(limit) as WalletStatsRow[];
}

export interface MarketEventRow {
  eventId: string;
  kind: MarketEventKind;
  mint: string | null;
  trader: string | null;
  txType: string | null;
  amountSol: number;
  marketCapSol: number | null;
  source: string;
  observedAt: number;
}

export function listRecentMarketEvents(limit = 100): MarketEventRow[] {
  return getDb()
    .prepare(
      `SELECT event_id AS eventId, kind, mint, trader, tx_type AS txType,
              amount_sol AS amountSol, market_cap_sol AS marketCapSol,
              source, observed_at AS observedAt
       FROM market_events
       ORDER BY observed_at DESC, id DESC
       LIMIT ?`
    )
    .all(limit) as MarketEventRow[];
}

export interface TokenTradeRow {
  mint: string;
  signature: string;
  timestamp: number;
  trader: string;
  type: string;
  amountSol: number;
  amountTokens: number;
  priceSol: number;
  source: string | null;
  insertedAt: number;
}

export function listRecentTokenTrades(limit = 100): TokenTradeRow[] {
  return getDb()
    .prepare(
      `SELECT mint, signature, timestamp, trader, type,
              amount_sol AS amountSol, amount_tokens AS amountTokens,
              price_sol AS priceSol, source, inserted_at AS insertedAt
       FROM token_trades
       ORDER BY timestamp DESC, inserted_at DESC
       LIMIT ?`
    )
    .all(limit) as TokenTradeRow[];
}

export function getWalletTokens(address: string): Array<{
  mint: string; buys: number; sells: number; volumeSol: number;
  pnlSol: number; pnlPercent: number; isFresh: boolean; isWash: boolean;
  bundleId: string | null; updatedAt: number;
}> {
  const rows = getDb()
    .prepare(
      `SELECT mint, buys, sells, volume_sol AS volumeSol, pnl_sol AS pnlSol,
              pnl_percent AS pnlPercent, is_fresh AS isFresh, is_wash AS isWash,
              bundle_id AS bundleId, updated_at AS updatedAt
       FROM wallet_token_stats WHERE address = ? ORDER BY updated_at DESC`
    )
    .all(address) as Array<{
      mint: string; buys: number; sells: number; volumeSol: number;
      pnlSol: number; pnlPercent: number; isFresh: number; isWash: number;
      bundleId: string | null; updatedAt: number;
    }>;
  return rows.map((r) => ({ ...r, isFresh: !!r.isFresh, isWash: !!r.isWash }));
}

// ── Dev wallet persistence ─────────────────────────────────────

export interface DevWalletRow {
  address: string;
  totalTokens: number;
  migratedCount: number;
  migrationRate: number;
  reached300kCount: number;
  rate300k: number;
  bestLaunchHour: number | null;
  totalVolumeSol: number;
  totalFeesSol: number;
  avgMcUsd: number | null;
  maxMcUsd: number | null;
  source: string;
  firstSeenAt: number;
  lastUpdatedAt: number;
}

export interface DevTokenRow {
  mint: string;
  creator: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  description: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  createdAt: number | null;
  marketCapUsd: number | null;
  athUsd: number | null;
  isMigrated: boolean;
  reached300k: boolean;
  totalSupply: number | null;
  source: string;
  lastUpdatedAt: number;
}

export function persistDevWallet(w: Omit<DevWalletRow, "firstSeenAt"> & { firstSeenAt?: number }) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO dev_wallets
       (address, total_tokens, migrated_count, migration_rate, reached_300k_count, rate_300k,
        best_launch_hour, total_volume_sol, total_fees_sol, avg_mc_usd, max_mc_usd,
        source, first_seen_at, last_updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(address) DO UPDATE SET
       total_tokens       = excluded.total_tokens,
       migrated_count     = excluded.migrated_count,
       migration_rate     = excluded.migration_rate,
       reached_300k_count = excluded.reached_300k_count,
       rate_300k          = excluded.rate_300k,
       best_launch_hour   = excluded.best_launch_hour,
       total_volume_sol   = excluded.total_volume_sol,
       total_fees_sol     = excluded.total_fees_sol,
       avg_mc_usd         = excluded.avg_mc_usd,
       max_mc_usd         = excluded.max_mc_usd,
       source             = excluded.source,
       last_updated_at    = excluded.last_updated_at`
  ).run(
    w.address, w.totalTokens, w.migratedCount, w.migrationRate,
    w.reached300kCount, w.rate300k, w.bestLaunchHour ?? null,
    w.totalVolumeSol, w.totalFeesSol,
    w.avgMcUsd ?? null, w.maxMcUsd ?? null,
    w.source ?? "pumpfun",
    w.firstSeenAt ?? now, now,
  );
}

export function persistDevTokens(tokens: DevTokenRow[]) {
  if (tokens.length === 0) return;
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO dev_tokens
       (mint, creator, symbol, name, image, description, twitter, telegram, website,
        created_at, market_cap_usd, ath_usd, is_migrated, reached_300k,
        total_supply, source, last_updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(mint, creator) DO UPDATE SET
       symbol         = excluded.symbol,
       name           = excluded.name,
       image          = COALESCE(excluded.image,   image),
       description    = COALESCE(excluded.description, description),
       twitter        = COALESCE(excluded.twitter,  twitter),
       telegram       = COALESCE(excluded.telegram, telegram),
       website        = COALESCE(excluded.website,  website),
       created_at     = COALESCE(excluded.created_at, created_at),
       market_cap_usd = excluded.market_cap_usd,
       ath_usd        = MAX(COALESCE(excluded.ath_usd, 0), COALESCE(ath_usd, 0)),
       is_migrated    = excluded.is_migrated,
       reached_300k   = excluded.reached_300k,
       total_supply   = COALESCE(excluded.total_supply, total_supply),
       source         = excluded.source,
       last_updated_at= excluded.last_updated_at`
  );
  // Run in a transaction for speed (2000+ tokens = very fast)
  const run = db.transaction((rows: DevTokenRow[]) => {
    for (const t of rows) {
      stmt.run(
        t.mint, t.creator, t.symbol ?? null, t.name ?? null, t.image ?? null,
        t.description ?? null, t.twitter ?? null, t.telegram ?? null, t.website ?? null,
        t.createdAt ?? null, t.marketCapUsd ?? null, t.athUsd ?? null,
        t.isMigrated ? 1 : 0, t.reached300k ? 1 : 0,
        t.totalSupply ?? null, t.source ?? "pumpfun", now,
      );
    }
  });
  run(tokens);
}

export function getDevWallet(address: string): DevWalletRow | null {
  const row = getDb().prepare(
    `SELECT address,
            total_tokens        AS totalTokens,
            migrated_count      AS migratedCount,
            migration_rate      AS migrationRate,
            reached_300k_count  AS reached300kCount,
            rate_300k           AS rate300k,
            best_launch_hour    AS bestLaunchHour,
            total_volume_sol    AS totalVolumeSol,
            total_fees_sol      AS totalFeesSol,
            avg_mc_usd          AS avgMcUsd,
            max_mc_usd          AS maxMcUsd,
            source, first_seen_at AS firstSeenAt,
            last_updated_at     AS lastUpdatedAt
     FROM dev_wallets WHERE address = ?`
  ).get(address) as DevWalletRow | undefined;
  return row ?? null;
}

export function getDevTokensByCreator(creator: string, limit = 5000): DevTokenRow[] {
  const rows = getDb().prepare(
    `SELECT mint, creator, symbol, name, image, description, twitter, telegram, website,
            created_at AS createdAt, market_cap_usd AS marketCapUsd, ath_usd AS athUsd,
            is_migrated AS isMigrated, reached_300k AS reached300k,
            total_supply AS totalSupply, source, last_updated_at AS lastUpdatedAt
     FROM dev_tokens WHERE creator = ? ORDER BY created_at DESC LIMIT ?`
  ).all(creator, limit) as any[];
  return rows.map((r) => ({ ...r, isMigrated: !!r.isMigrated, reached300k: !!r.reached300k } as DevTokenRow));
}

export function getDevTokenByMint(mint: string): DevTokenRow | null {
  const row = getDb().prepare(
    `SELECT mint, creator, symbol, name, image, description, twitter, telegram, website,
            created_at AS createdAt, market_cap_usd AS marketCapUsd, ath_usd AS athUsd,
            is_migrated AS isMigrated, reached_300k AS reached300k,
            total_supply AS totalSupply, token_volume_sol AS tokenVolumeSol,
            token_volume_usd AS tokenVolumeUsd, source, last_updated_at AS lastUpdatedAt
     FROM dev_tokens WHERE mint = ? ORDER BY last_updated_at DESC LIMIT 1`
  ).get(mint) as any | undefined;
  return row ? ({ ...row, isMigrated: !!row.isMigrated, reached300k: !!row.reached300k } as DevTokenRow) : null;
}

export function getPersistedCreatorForMint(mint: string): string | null {
  try {
    const tokenRow = getDb().prepare(
      `SELECT creator
       FROM dev_tokens
       WHERE mint = ?
       ORDER BY last_updated_at DESC
       LIMIT 1`
    ).get(mint) as { creator?: string | null } | undefined;
    if (tokenRow?.creator) return tokenRow.creator;
  } catch {
    // ignore token-row lookup errors and try forensics fallback
  }

  try {
    const forensicsRow = getDb().prepare(
      `SELECT creator
       FROM dev_forensics_analyses
       WHERE source_mint = ?
       ORDER BY analyzed_at DESC
       LIMIT 1`
    ).get(mint) as { creator?: string | null } | undefined;
    if (forensicsRow?.creator) return forensicsRow.creator;
  } catch {
    // ignore and fall through to null
  }

  return null;
}

export function getCachedTokenVolume(mint: string): { tokenVolumeSol: number | null; tokenVolumeUsd: number | null } | null {
  const row = getDb().prepare(
    `SELECT token_volume_sol AS tokenVolumeSol, token_volume_usd AS tokenVolumeUsd,
            last_updated_at AS lastUpdatedAt
     FROM dev_tokens WHERE mint = ? AND token_volume_usd IS NOT NULL
     ORDER BY last_updated_at DESC LIMIT 1`
  ).get(mint) as any | undefined;
  if (!row) return null;
  // Cache is valid for 24 hours
  if (Date.now() - row.lastUpdatedAt > 24 * 60 * 60 * 1000) return null;
  return { tokenVolumeSol: row.tokenVolumeSol, tokenVolumeUsd: row.tokenVolumeUsd };
}

export function upsertDevTokenVolume(mint: string, creator: string, tokenVolumeSol: number | null, tokenVolumeUsd: number | null) {
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO dev_tokens (mint, creator, token_volume_sol, token_volume_usd, last_updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(mint, creator) DO UPDATE SET
       token_volume_sol = excluded.token_volume_sol,
       token_volume_usd = excluded.token_volume_usd,
       last_updated_at = excluded.last_updated_at`
  ).run(mint, creator, tokenVolumeSol, tokenVolumeUsd, now);
}

export interface DevForensicsAnalysisRow {
  creator: string;
  sourceMint: string | null;
  payload: unknown;
  totalCreatedTokens: number;
  totalMigratedTokens: number;
  migrationRate: number;
  avgLifespanMinutes: number | null;
  successRate: number;
  analyzedAt?: number;
}

export function persistDevForensicsAnalysis(row: DevForensicsAnalysisRow) {
  const now = row.analyzedAt ?? Date.now();
  getDb().prepare(
    `INSERT INTO dev_forensics_analyses
       (creator, source_mint, payload, total_created_tokens, total_migrated_tokens,
        migration_rate, avg_lifespan_minutes, success_rate, analyzed_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    row.creator,
    row.sourceMint,
    JSON.stringify(row.payload),
    row.totalCreatedTokens,
    row.totalMigratedTokens,
    row.migrationRate,
    row.avgLifespanMinutes,
    row.successRate,
    now,
  );
}

export function listTopDevWallets(orderBy: "tokens" | "migration" | "300k" = "tokens", limit = 100): DevWalletRow[] {
  const col = orderBy === "migration" ? "migration_rate" : orderBy === "300k" ? "rate_300k" : "total_tokens";
  return getDb().prepare(
    `SELECT address, total_tokens AS totalTokens, migrated_count AS migratedCount,
            migration_rate AS migrationRate, reached_300k_count AS reached300kCount,
            rate_300k AS rate300k, best_launch_hour AS bestLaunchHour,
            total_volume_sol AS totalVolumeSol, total_fees_sol AS totalFeesSol,
            avg_mc_usd AS avgMcUsd, max_mc_usd AS maxMcUsd,
            source, first_seen_at AS firstSeenAt, last_updated_at AS lastUpdatedAt
     FROM dev_wallets ORDER BY ${col} DESC LIMIT ?`
  ).all(limit) as DevWalletRow[];
}

export interface ApifyRunRow {
  runId: string;
  actorId: string;
  actorType: string;
  status: string;
  defaultDatasetId: string | null;
  startedAt: number;
  finishedAt: number | null;
  input: unknown;
  meta: unknown;
  lastSyncedAt: number;
}

export interface ApifySyncEventRow {
  id?: number;
  source: string;
  runId: string | null;
  datasetId: string | null;
  status: string;
  importedItems: number;
  importedCreators: number;
  importedTokens: number;
  message: string | null;
  meta: unknown;
  createdAt?: number;
}

export function persistApifyRun(row: ApifyRunRow) {
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO apify_runs
       (run_id, actor_id, actor_type, status, default_dataset_id, started_at, finished_at, input_json, meta_json, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       actor_id = excluded.actor_id,
       actor_type = excluded.actor_type,
       status = excluded.status,
       default_dataset_id = COALESCE(excluded.default_dataset_id, apify_runs.default_dataset_id),
       started_at = excluded.started_at,
       finished_at = COALESCE(excluded.finished_at, apify_runs.finished_at),
       input_json = COALESCE(excluded.input_json, apify_runs.input_json),
       meta_json = COALESCE(excluded.meta_json, apify_runs.meta_json),
       last_synced_at = excluded.last_synced_at`
  ).run(
    row.runId,
    row.actorId,
    row.actorType,
    row.status,
    row.defaultDatasetId ?? null,
    row.startedAt,
    row.finishedAt ?? null,
    row.input == null ? null : JSON.stringify(row.input),
    row.meta == null ? null : JSON.stringify(row.meta),
    row.lastSyncedAt ?? now,
  );
}

export function getApifyRun(runId: string): ApifyRunRow | null {
  const row = getDb().prepare(
    `SELECT run_id AS runId, actor_id AS actorId, actor_type AS actorType,
            status, default_dataset_id AS defaultDatasetId, started_at AS startedAt,
            finished_at AS finishedAt, input_json AS inputJson, meta_json AS metaJson,
            last_synced_at AS lastSyncedAt
     FROM apify_runs WHERE run_id = ?`
  ).get(runId) as { runId: string; actorId: string; actorType: string; status: string; defaultDatasetId: string | null; startedAt: number; finishedAt: number | null; inputJson: string | null; metaJson: string | null; lastSyncedAt: number } | undefined;
  if (!row) return null;
  return {
    runId: row.runId,
    actorId: row.actorId,
    actorType: row.actorType,
    status: row.status,
    defaultDatasetId: row.defaultDatasetId,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    input: row.inputJson ? JSON.parse(row.inputJson) : null,
    meta: row.metaJson ? JSON.parse(row.metaJson) : null,
    lastSyncedAt: row.lastSyncedAt,
  };
}

export function listApifyRuns(actorType?: string, limit = 20): ApifyRunRow[] {
  const rows = actorType
    ? getDb().prepare(
        `SELECT run_id AS runId, actor_id AS actorId, actor_type AS actorType,
                status, default_dataset_id AS defaultDatasetId, started_at AS startedAt,
                finished_at AS finishedAt, input_json AS inputJson, meta_json AS metaJson,
                last_synced_at AS lastSyncedAt
         FROM apify_runs WHERE actor_type = ?
         ORDER BY started_at DESC LIMIT ?`
      ).all(actorType, limit)
    : getDb().prepare(
        `SELECT run_id AS runId, actor_id AS actorId, actor_type AS actorType,
                status, default_dataset_id AS defaultDatasetId, started_at AS startedAt,
                finished_at AS finishedAt, input_json AS inputJson, meta_json AS metaJson,
                last_synced_at AS lastSyncedAt
         FROM apify_runs ORDER BY started_at DESC LIMIT ?`
      ).all(limit);
  return (rows as Array<{ runId: string; actorId: string; actorType: string; status: string; defaultDatasetId: string | null; startedAt: number; finishedAt: number | null; inputJson: string | null; metaJson: string | null; lastSyncedAt: number }>).map((row) => ({
    runId: row.runId,
    actorId: row.actorId,
    actorType: row.actorType,
    status: row.status,
    defaultDatasetId: row.defaultDatasetId,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    input: row.inputJson ? JSON.parse(row.inputJson) : null,
    meta: row.metaJson ? JSON.parse(row.metaJson) : null,
    lastSyncedAt: row.lastSyncedAt,
  }));
}

export function persistApifySyncEvent(row: ApifySyncEventRow) {
  const now = row.createdAt ?? Date.now();
  getDb().prepare(
    `INSERT INTO apify_sync_events
       (source, run_id, dataset_id, status, imported_items, imported_creators, imported_tokens, message, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.source,
    row.runId,
    row.datasetId,
    row.status,
    row.importedItems,
    row.importedCreators,
    row.importedTokens,
    row.message,
    row.meta == null ? null : JSON.stringify(row.meta),
    now,
  );
}

export function listApifySyncEvents(source?: string, limit = 20): ApifySyncEventRow[] {
  const rows = source
    ? getDb().prepare(
        `SELECT id, source, run_id AS runId, dataset_id AS datasetId, status,
                imported_items AS importedItems, imported_creators AS importedCreators,
                imported_tokens AS importedTokens, message, meta_json AS metaJson,
                created_at AS createdAt
         FROM apify_sync_events WHERE source = ?
         ORDER BY created_at DESC LIMIT ?`
      ).all(source, limit)
    : getDb().prepare(
        `SELECT id, source, run_id AS runId, dataset_id AS datasetId, status,
                imported_items AS importedItems, imported_creators AS importedCreators,
                imported_tokens AS importedTokens, message, meta_json AS metaJson,
                created_at AS createdAt
         FROM apify_sync_events ORDER BY created_at DESC LIMIT ?`
      ).all(limit);
  return (rows as Array<{ id: number; source: string; runId: string | null; datasetId: string | null; status: string; importedItems: number; importedCreators: number; importedTokens: number; message: string | null; metaJson: string | null; createdAt: number }>).map((row) => ({
    id: row.id,
    source: row.source,
    runId: row.runId,
    datasetId: row.datasetId,
    status: row.status,
    importedItems: row.importedItems,
    importedCreators: row.importedCreators,
    importedTokens: row.importedTokens,
    message: row.message,
    meta: row.metaJson ? JSON.parse(row.metaJson) : null,
    createdAt: row.createdAt,
  }));
}

export type MarketEventKind = "launch" | "migration" | "trade";

export interface MarketEventInsert {
  eventId: string;
  kind: MarketEventKind;
  mint: string | null;
  trader?: string | null;
  txType?: string | null;
  amountSol?: number | null;
  marketCapSol?: number | null;
  payload?: unknown;
  source?: string;
  observedAt: number;
}

export interface MarketOverviewAggregateRow {
  launched: number;
  migrated: number;
  totalVolumeSol: number;
  beforeMigrationVolumeSol: number;
  afterMigrationVolumeSol: number;
  totalTraders: number;
  beforeMigrationTraders: number;
  afterMigrationTraders: number;
  newWallets: number;
  activeTokens: number;
  avgMarketCapSol: number;
  sampledMarketCaps: number;
}

export function persistMarketEvent(event: MarketEventInsert) {
  getDb().prepare(
    `INSERT OR IGNORE INTO market_events
       (event_id, kind, mint, trader, tx_type, amount_sol, market_cap_sol, payload_json, source, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.eventId,
    event.kind,
    event.mint,
    event.trader ?? null,
    event.txType ?? null,
    event.amountSol ?? 0,
    event.marketCapSol ?? null,
    event.payload == null ? null : JSON.stringify(event.payload),
    event.source ?? "pumpportal",
    event.observedAt,
  );
}

export function getMarketOverviewAggregate(sinceMs: number): MarketOverviewAggregateRow {
  const db = getDb();
  const launched = db.prepare(`SELECT COUNT(*) AS count FROM market_events WHERE kind = 'launch' AND observed_at >= ?`).get(sinceMs) as { count: number };
  const migrated = db.prepare(`SELECT COUNT(*) AS count FROM market_events WHERE kind = 'migration' AND observed_at >= ?`).get(sinceMs) as { count: number };
  const trade = db.prepare(
    `SELECT
       COALESCE(SUM(amount_sol), 0) AS totalVolumeSol,
       COUNT(DISTINCT trader) AS totalTraders,
       COUNT(DISTINCT mint) AS activeTokens
     FROM market_events
     WHERE kind = 'trade' AND observed_at >= ?`
  ).get(sinceMs) as { totalVolumeSol: number; totalTraders: number; activeTokens: number };
  const preTrade = db.prepare(
    `SELECT
       COALESCE(SUM(amount_sol), 0) AS volumeSol,
       COUNT(DISTINCT trader) AS traders
     FROM market_events
     WHERE kind = 'trade' AND observed_at >= ?
       AND mint NOT IN (SELECT mint FROM market_events WHERE kind = 'migration' AND mint IS NOT NULL)`
  ).get(sinceMs) as { volumeSol: number; traders: number };
  const postTrade = db.prepare(
    `SELECT
       COALESCE(SUM(amount_sol), 0) AS volumeSol,
       COUNT(DISTINCT trader) AS traders
     FROM market_events
     WHERE kind = 'trade' AND observed_at >= ?
       AND mint IN (SELECT mint FROM market_events WHERE kind = 'migration' AND mint IS NOT NULL)`
  ).get(sinceMs) as { volumeSol: number; traders: number };
  const newWallets = db.prepare(
    `SELECT COUNT(*) AS count
     FROM wallet_stats
     WHERE first_seen IS NOT NULL AND first_seen >= ?`
  ).get(sinceMs) as { count: number };
  const marketCap = db.prepare(
    `SELECT AVG(market_cap_sol) AS avgMarketCapSol, COUNT(market_cap_sol) AS sampledMarketCaps
     FROM (
       SELECT mint, MAX(market_cap_sol) AS market_cap_sol
       FROM market_events
       WHERE observed_at >= ? AND market_cap_sol IS NOT NULL AND market_cap_sol > 0
       GROUP BY mint
     )`
  ).get(sinceMs) as { avgMarketCapSol: number | null; sampledMarketCaps: number };

  return {
    launched: launched.count,
    migrated: migrated.count,
    totalVolumeSol: trade.totalVolumeSol,
    beforeMigrationVolumeSol: preTrade.volumeSol,
    afterMigrationVolumeSol: postTrade.volumeSol,
    totalTraders: trade.totalTraders,
    beforeMigrationTraders: preTrade.traders,
    afterMigrationTraders: postTrade.traders,
    newWallets: newWallets.count,
    activeTokens: trade.activeTokens,
    avgMarketCapSol: marketCap.avgMarketCapSol ?? 0,
    sampledMarketCaps: marketCap.sampledMarketCaps,
  };
}

export function getMarketEventSeries(sinceMs: number, intervalMs: number): Array<{
  bucket: number;
  launched: number;
  migrated: number;
  volumeSol: number;
  traders: number;
  activeTokens: number;
}> {
  const rows = getDb().prepare(
    `SELECT
       CAST((observed_at / ?) AS INTEGER) * ? AS bucket,
       SUM(CASE WHEN kind = 'launch' THEN 1 ELSE 0 END) AS launched,
       SUM(CASE WHEN kind = 'migration' THEN 1 ELSE 0 END) AS migrated,
       COALESCE(SUM(CASE WHEN kind = 'trade' THEN amount_sol ELSE 0 END), 0) AS volumeSol,
       COUNT(DISTINCT CASE WHEN kind = 'trade' THEN trader ELSE NULL END) AS traders,
       COUNT(DISTINCT CASE WHEN kind = 'trade' THEN mint ELSE NULL END) AS activeTokens
     FROM market_events
     WHERE observed_at >= ?
     GROUP BY bucket
     ORDER BY bucket ASC`
  ).all(intervalMs, intervalMs, sinceMs) as Array<{
    bucket: number;
    launched: number;
    migrated: number;
    volumeSol: number;
    traders: number;
    activeTokens: number;
  }>;
  return rows;
}

export function getNewWalletSeries(sinceMs: number, intervalMs: number): Array<{
  bucket: number;
  wallets: number;
}> {
  const rows = getDb().prepare(
    `SELECT
       CAST((first_seen / ?) AS INTEGER) * ? AS bucket,
       COUNT(*) AS wallets
     FROM wallet_stats
     WHERE first_seen IS NOT NULL AND first_seen >= ?
     GROUP BY bucket
     ORDER BY bucket ASC`
  ).all(intervalMs, intervalMs, sinceMs) as Array<{
    bucket: number;
    wallets: number;
  }>;
  return rows;
}

export function getMarketCollectorStatus(): { events: number; lastEventAt: number | null; launches: number; migrations: number; trades: number } {
  const row = getDb().prepare(
    `SELECT
       COUNT(*) AS events,
       MAX(observed_at) AS lastEventAt,
       SUM(CASE WHEN kind = 'launch' THEN 1 ELSE 0 END) AS launches,
       SUM(CASE WHEN kind = 'migration' THEN 1 ELSE 0 END) AS migrations,
       SUM(CASE WHEN kind = 'trade' THEN 1 ELSE 0 END) AS trades
     FROM market_events`
  ).get() as { events: number; lastEventAt: number | null; launches: number | null; migrations: number | null; trades: number | null };
  return {
    events: row.events,
    lastEventAt: row.lastEventAt,
    launches: row.launches ?? 0,
    migrations: row.migrations ?? 0,
    trades: row.trades ?? 0,
  };
}

export type MigrationWorkbookKind = "token_report" | "wallet_report" | "mixed" | "unknown";

export interface MigrationXlsxFileRow {
  filePath: string;
  fileName: string;
  workbookKind: MigrationWorkbookKind;
  sheetCount: number;
  totalRows: number;
  tokenRows: number;
  walletRows: number;
  summary: unknown;
  importedAt?: number;
}

export interface MigrationTokenRow {
  filePath: string;
  fileName: string;
  sheetName: string;
  rowIndex: number;
  tokenAddress: string;
  ticker: string | null;
  totalUniqueBuyers: number | null;
  currentMc: number | null;
  marketCapMax: number | null;
  mintTimeText: string | null;
  migrationTimeText: string | null;
  timeBeforeMigrationText: string | null;
  timeBeforeMigrationSeconds: number | null;
  creator: string | null;
  creatorSource: string | null;
  raw: unknown;
  importedAt?: number;
}

export interface MigrationWalletRow {
  filePath: string;
  fileName: string;
  sheetName: string;
  rowIndex: number;
  wallet: string;
  wr: number | null;
  roi: number | null;
  pnl: number | null;
  rockets: number | null;
  medianRoi: number | null;
  avgRoi: number | null;
  fastTrades: number | null;
  fastTradesPct: number | null;
  balance: number | null;
  totalTokens: number | null;
  soldGtBought: number | null;
  soldGtBoughtPct: number | null;
  avgTradeDurationText: string | null;
  pfTokens: number | null;
  pfTradesPct: number | null;
  avgBuySol: number | null;
  medianSolBuy: number | null;
  avgMcapFirstTx: string | null;
  avgMcapLastTx: string | null;
  lastTradeText: string | null;
  lastTradeHour: number | null;
  migratedTokens: number | null;
  migratedPct: number | null;
  raw: unknown;
  importedAt?: number;
}

export function persistMigrationXlsxFile(row: MigrationXlsxFileRow) {
  const now = row.importedAt ?? Date.now();
  getDb().prepare(
    `INSERT INTO migration_xlsx_files
       (file_path, file_name, workbook_kind, sheet_count, total_rows, token_rows, wallet_rows, summary_json, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET
       file_name = excluded.file_name,
       workbook_kind = excluded.workbook_kind,
       sheet_count = excluded.sheet_count,
       total_rows = excluded.total_rows,
       token_rows = excluded.token_rows,
       wallet_rows = excluded.wallet_rows,
       summary_json = excluded.summary_json,
       imported_at = excluded.imported_at`
  ).run(
    row.filePath,
    row.fileName,
    row.workbookKind,
    row.sheetCount,
    row.totalRows,
    row.tokenRows,
    row.walletRows,
    row.summary == null ? null : JSON.stringify(row.summary),
    now,
  );
}

export function persistMigrationTokenRows(rows: MigrationTokenRow[]) {
  if (rows.length === 0) return;
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO migration_token_rows
       (file_path, file_name, sheet_name, row_index, token_address, ticker,
        total_unique_buyers, current_mc, market_cap_max, mint_time_text,
        migration_time_text, time_before_migration_text, time_before_migration_seconds,
        creator, creator_source, raw_json, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_path, sheet_name, row_index) DO UPDATE SET
       file_name = excluded.file_name,
       token_address = excluded.token_address,
       ticker = excluded.ticker,
       total_unique_buyers = excluded.total_unique_buyers,
       current_mc = excluded.current_mc,
       market_cap_max = excluded.market_cap_max,
       mint_time_text = excluded.mint_time_text,
       migration_time_text = excluded.migration_time_text,
       time_before_migration_text = excluded.time_before_migration_text,
       time_before_migration_seconds = excluded.time_before_migration_seconds,
       creator = COALESCE(excluded.creator, migration_token_rows.creator),
       creator_source = COALESCE(excluded.creator_source, migration_token_rows.creator_source),
       raw_json = excluded.raw_json,
       imported_at = excluded.imported_at`
  );

  const tx = db.transaction((batch: MigrationTokenRow[]) => {
    for (const row of batch) {
      stmt.run(
        row.filePath,
        row.fileName,
        row.sheetName,
        row.rowIndex,
        row.tokenAddress,
        row.ticker,
        row.totalUniqueBuyers,
        row.currentMc,
        row.marketCapMax,
        row.mintTimeText,
        row.migrationTimeText,
        row.timeBeforeMigrationText,
        row.timeBeforeMigrationSeconds,
        row.creator,
        row.creatorSource,
        JSON.stringify(row.raw),
        row.importedAt ?? now,
      );
    }
  });

  tx(rows);
}

export interface TwitterSocialDiscoveryInput {
  subjectType?: "account" | "community";
  handle?: string | null;
  displayName?: string | null;
  url?: string | null;
  contractAddress?: string | null;
  symbol?: string | null;
  sourceQuery: string;
  matchedIn?: string;
  profileText?: string | null;
  tweetId?: string | null;
  tweetText?: string | null;
  tweetPostedAt?: number | null;
  accountCreatedAt?: number | null;
  discoveredAt?: number;
  followers?: number | null;
  following?: number | null;
  postsCount?: number | null;
  isVerified?: boolean;
  isMemecoin?: boolean;
  mentionsPumpfun?: boolean;
  raw?: unknown;
}

export function persistTwitterSocialDiscoveries(rows: TwitterSocialDiscoveryInput[]) {
  if (rows.length === 0) return;
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO twitter_social_discoveries
       (subject_type, handle, display_name, url, contract_address, symbol, source_query,
        matched_in, profile_text, tweet_id, tweet_text, tweet_posted_at, account_created_at,
        discovered_at, followers, following, posts_count, is_verified, is_memecoin,
        mentions_pumpfun, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET
       display_name = COALESCE(excluded.display_name, twitter_social_discoveries.display_name),
       url = COALESCE(excluded.url, twitter_social_discoveries.url),
       symbol = COALESCE(excluded.symbol, twitter_social_discoveries.symbol),
       matched_in = excluded.matched_in,
       profile_text = COALESCE(excluded.profile_text, twitter_social_discoveries.profile_text),
       tweet_text = COALESCE(excluded.tweet_text, twitter_social_discoveries.tweet_text),
       tweet_posted_at = COALESCE(excluded.tweet_posted_at, twitter_social_discoveries.tweet_posted_at),
       account_created_at = COALESCE(excluded.account_created_at, twitter_social_discoveries.account_created_at),
       discovered_at = excluded.discovered_at,
       followers = COALESCE(excluded.followers, twitter_social_discoveries.followers),
       following = COALESCE(excluded.following, twitter_social_discoveries.following),
       posts_count = COALESCE(excluded.posts_count, twitter_social_discoveries.posts_count),
       is_verified = MAX(excluded.is_verified, twitter_social_discoveries.is_verified),
       is_memecoin = MAX(excluded.is_memecoin, twitter_social_discoveries.is_memecoin),
       mentions_pumpfun = MAX(excluded.mentions_pumpfun, twitter_social_discoveries.mentions_pumpfun),
       raw_json = COALESCE(excluded.raw_json, twitter_social_discoveries.raw_json)`
  );

  const tx = db.transaction((batch: TwitterSocialDiscoveryInput[]) => {
    for (const row of batch) {
      stmt.run(
        row.subjectType ?? "account",
        row.handle ?? null,
        row.displayName ?? null,
        row.url ?? null,
        row.contractAddress ?? null,
        row.symbol ?? null,
        row.sourceQuery,
        row.matchedIn ?? "tweet",
        row.profileText ?? null,
        row.tweetId ?? null,
        row.tweetText ?? null,
        row.tweetPostedAt ?? null,
        row.accountCreatedAt ?? null,
        row.discoveredAt ?? now,
        row.followers ?? null,
        row.following ?? null,
        row.postsCount ?? null,
        row.isVerified ? 1 : 0,
        row.isMemecoin ? 1 : 0,
        row.mentionsPumpfun ? 1 : 0,
        row.raw == null ? null : JSON.stringify(row.raw),
      );
    }
  });

  tx(rows);
}

export function persistMigrationWalletRows(rows: MigrationWalletRow[]) {
  if (rows.length === 0) return;
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO migration_wallet_rows
       (file_path, file_name, sheet_name, row_index, wallet, wr, roi, pnl, rockets,
        median_roi, avg_roi, fast_trades, fast_trades_pct, balance, total_tokens,
        sold_gt_bought, sold_gt_bought_pct, avg_trade_duration_text, pf_tokens, pf_trades_pct,
        avg_buy_sol, median_sol_buy, avg_mcap_first_tx, avg_mcap_last_tx, last_trade_text,
        last_trade_hour, migrated_tokens, migrated_pct, raw_json, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_path, sheet_name, row_index) DO UPDATE SET
       file_name = excluded.file_name,
       wallet = excluded.wallet,
       wr = excluded.wr,
       roi = excluded.roi,
       pnl = excluded.pnl,
       rockets = excluded.rockets,
       median_roi = excluded.median_roi,
       avg_roi = excluded.avg_roi,
       fast_trades = excluded.fast_trades,
       fast_trades_pct = excluded.fast_trades_pct,
       balance = excluded.balance,
       total_tokens = excluded.total_tokens,
       sold_gt_bought = excluded.sold_gt_bought,
       sold_gt_bought_pct = excluded.sold_gt_bought_pct,
       avg_trade_duration_text = excluded.avg_trade_duration_text,
       pf_tokens = excluded.pf_tokens,
       pf_trades_pct = excluded.pf_trades_pct,
       avg_buy_sol = excluded.avg_buy_sol,
       median_sol_buy = excluded.median_sol_buy,
       avg_mcap_first_tx = excluded.avg_mcap_first_tx,
       avg_mcap_last_tx = excluded.avg_mcap_last_tx,
       last_trade_text = excluded.last_trade_text,
       last_trade_hour = excluded.last_trade_hour,
       migrated_tokens = excluded.migrated_tokens,
       migrated_pct = excluded.migrated_pct,
       raw_json = excluded.raw_json,
       imported_at = excluded.imported_at`
  );

  const tx = db.transaction((batch: MigrationWalletRow[]) => {
    for (const row of batch) {
      stmt.run(
        row.filePath,
        row.fileName,
        row.sheetName,
        row.rowIndex,
        row.wallet,
        row.wr,
        row.roi,
        row.pnl,
        row.rockets,
        row.medianRoi,
        row.avgRoi,
        row.fastTrades,
        row.fastTradesPct,
        row.balance,
        row.totalTokens,
        row.soldGtBought,
        row.soldGtBoughtPct,
        row.avgTradeDurationText,
        row.pfTokens,
        row.pfTradesPct,
        row.avgBuySol,
        row.medianSolBuy,
        row.avgMcapFirstTx,
        row.avgMcapLastTx,
        row.lastTradeText,
        row.lastTradeHour,
        row.migratedTokens,
        row.migratedPct,
        JSON.stringify(row.raw),
        row.importedAt ?? now,
      );
    }
  });

  tx(rows);
}

export function listMigrationXlsxFiles(limit = 100): MigrationXlsxFileRow[] {
  const rows = getDb().prepare(
    `SELECT
       file_path AS filePath,
       file_name AS fileName,
       workbook_kind AS workbookKind,
       sheet_count AS sheetCount,
       total_rows AS totalRows,
       token_rows AS tokenRows,
       wallet_rows AS walletRows,
       summary_json AS summaryJson,
       imported_at AS importedAt
     FROM migration_xlsx_files
     ORDER BY imported_at DESC
     LIMIT ?`
  ).all(limit) as Array<{
    filePath: string;
    fileName: string;
    workbookKind: MigrationWorkbookKind;
    sheetCount: number;
    totalRows: number;
    tokenRows: number;
    walletRows: number;
    summaryJson: string | null;
    importedAt: number;
  }>;

  return rows.map((row) => ({
    filePath: row.filePath,
    fileName: row.fileName,
    workbookKind: row.workbookKind,
    sheetCount: row.sheetCount,
    totalRows: row.totalRows,
    tokenRows: row.tokenRows,
    walletRows: row.walletRows,
    summary: row.summaryJson ? JSON.parse(row.summaryJson) : null,
    importedAt: row.importedAt,
  })) as MigrationXlsxFileRow[];
}

export function listMigrationTokenRows(filePath?: string, limit = 500): MigrationTokenRow[] {
  const query = filePath
    ? `SELECT file_path AS filePath, file_name AS fileName, sheet_name AS sheetName, row_index AS rowIndex,
              token_address AS tokenAddress, ticker, total_unique_buyers AS totalUniqueBuyers,
              current_mc AS currentMc, market_cap_max AS marketCapMax, mint_time_text AS mintTimeText,
              migration_time_text AS migrationTimeText, time_before_migration_text AS timeBeforeMigrationText,
              time_before_migration_seconds AS timeBeforeMigrationSeconds, creator, creator_source AS creatorSource,
              raw_json AS rawJson, imported_at AS importedAt
       FROM migration_token_rows WHERE file_path = ? ORDER BY row_index ASC LIMIT ?`
    : `SELECT file_path AS filePath, file_name AS fileName, sheet_name AS sheetName, row_index AS rowIndex,
              token_address AS tokenAddress, ticker, total_unique_buyers AS totalUniqueBuyers,
              current_mc AS currentMc, market_cap_max AS marketCapMax, mint_time_text AS mintTimeText,
              migration_time_text AS migrationTimeText, time_before_migration_text AS timeBeforeMigrationText,
              time_before_migration_seconds AS timeBeforeMigrationSeconds, creator, creator_source AS creatorSource,
              raw_json AS rawJson, imported_at AS importedAt
       FROM migration_token_rows ORDER BY imported_at DESC, row_index ASC LIMIT ?`;
  const rows = filePath
    ? getDb().prepare(query).all(filePath, limit)
    : getDb().prepare(query).all(limit);
  const typedRows = rows as Array<{
    filePath: string;
    fileName: string;
    sheetName: string;
    rowIndex: number;
    tokenAddress: string;
    ticker: string | null;
    totalUniqueBuyers: number | null;
    currentMc: number | null;
    marketCapMax: number | null;
    mintTimeText: string | null;
    migrationTimeText: string | null;
    timeBeforeMigrationText: string | null;
    timeBeforeMigrationSeconds: number | null;
    creator: string | null;
    creatorSource: string | null;
    rawJson: string;
    importedAt: number;
  }>;
  return typedRows.map((row) => ({
    filePath: row.filePath,
    fileName: row.fileName,
    sheetName: row.sheetName,
    rowIndex: row.rowIndex,
    tokenAddress: row.tokenAddress,
    ticker: row.ticker ?? null,
    totalUniqueBuyers: row.totalUniqueBuyers ?? null,
    currentMc: row.currentMc ?? null,
    marketCapMax: row.marketCapMax ?? null,
    mintTimeText: row.mintTimeText ?? null,
    migrationTimeText: row.migrationTimeText ?? null,
    timeBeforeMigrationText: row.timeBeforeMigrationText ?? null,
    timeBeforeMigrationSeconds: row.timeBeforeMigrationSeconds ?? null,
    creator: row.creator ?? null,
    creatorSource: row.creatorSource ?? null,
    raw: row.rawJson ? JSON.parse(row.rawJson) : null,
    importedAt: row.importedAt,
  })) as MigrationTokenRow[];
}

export function listMigrationWalletRows(filePath?: string, limit = 500): MigrationWalletRow[] {
  const query = filePath
    ? `SELECT file_path AS filePath, file_name AS fileName, sheet_name AS sheetName, row_index AS rowIndex,
              wallet, wr, roi, pnl, rockets, median_roi AS medianRoi, avg_roi AS avgRoi,
              fast_trades AS fastTrades, fast_trades_pct AS fastTradesPct, balance, total_tokens AS totalTokens,
              sold_gt_bought AS soldGtBought, sold_gt_bought_pct AS soldGtBoughtPct,
              avg_trade_duration_text AS avgTradeDurationText, pf_tokens AS pfTokens, pf_trades_pct AS pfTradesPct,
              avg_buy_sol AS avgBuySol, median_sol_buy AS medianSolBuy, avg_mcap_first_tx AS avgMcapFirstTx,
              avg_mcap_last_tx AS avgMcapLastTx, last_trade_text AS lastTradeText, last_trade_hour AS lastTradeHour,
              migrated_tokens AS migratedTokens, migrated_pct AS migratedPct, raw_json AS rawJson, imported_at AS importedAt
       FROM migration_wallet_rows WHERE file_path = ? ORDER BY row_index ASC LIMIT ?`
    : `SELECT file_path AS filePath, file_name AS fileName, sheet_name AS sheetName, row_index AS rowIndex,
              wallet, wr, roi, pnl, rockets, median_roi AS medianRoi, avg_roi AS avgRoi,
              fast_trades AS fastTrades, fast_trades_pct AS fastTradesPct, balance, total_tokens AS totalTokens,
              sold_gt_bought AS soldGtBought, sold_gt_bought_pct AS soldGtBoughtPct,
              avg_trade_duration_text AS avgTradeDurationText, pf_tokens AS pfTokens, pf_trades_pct AS pfTradesPct,
              avg_buy_sol AS avgBuySol, median_sol_buy AS medianSolBuy, avg_mcap_first_tx AS avgMcapFirstTx,
              avg_mcap_last_tx AS avgMcapLastTx, last_trade_text AS lastTradeText, last_trade_hour AS lastTradeHour,
              migrated_tokens AS migratedTokens, migrated_pct AS migratedPct, raw_json AS rawJson, imported_at AS importedAt
       FROM migration_wallet_rows ORDER BY imported_at DESC, row_index ASC LIMIT ?`;
  const rows = filePath
    ? getDb().prepare(query).all(filePath, limit)
    : getDb().prepare(query).all(limit);
  const typedRows = rows as Array<{
    filePath: string;
    fileName: string;
    sheetName: string;
    rowIndex: number;
    wallet: string;
    wr: number | null;
    roi: number | null;
    pnl: number | null;
    rockets: number | null;
    medianRoi: number | null;
    avgRoi: number | null;
    fastTrades: number | null;
    fastTradesPct: number | null;
    balance: number | null;
    totalTokens: number | null;
    soldGtBought: number | null;
    soldGtBoughtPct: number | null;
    avgTradeDurationText: string | null;
    pfTokens: number | null;
    pfTradesPct: number | null;
    avgBuySol: number | null;
    medianSolBuy: number | null;
    avgMcapFirstTx: string | null;
    avgMcapLastTx: string | null;
    lastTradeText: string | null;
    lastTradeHour: number | null;
    migratedTokens: number | null;
    migratedPct: number | null;
    rawJson: string;
    importedAt: number;
  }>;
  return typedRows.map((row) => ({
    filePath: row.filePath,
    fileName: row.fileName,
    sheetName: row.sheetName,
    rowIndex: row.rowIndex,
    wallet: row.wallet,
    wr: row.wr ?? null,
    roi: row.roi ?? null,
    pnl: row.pnl ?? null,
    rockets: row.rockets ?? null,
    medianRoi: row.medianRoi ?? null,
    avgRoi: row.avgRoi ?? null,
    fastTrades: row.fastTrades ?? null,
    fastTradesPct: row.fastTradesPct ?? null,
    balance: row.balance ?? null,
    totalTokens: row.totalTokens ?? null,
    soldGtBought: row.soldGtBought ?? null,
    soldGtBoughtPct: row.soldGtBoughtPct ?? null,
    avgTradeDurationText: row.avgTradeDurationText ?? null,
    pfTokens: row.pfTokens ?? null,
    pfTradesPct: row.pfTradesPct ?? null,
    avgBuySol: row.avgBuySol ?? null,
    medianSolBuy: row.medianSolBuy ?? null,
    avgMcapFirstTx: row.avgMcapFirstTx ?? null,
    avgMcapLastTx: row.avgMcapLastTx ?? null,
    lastTradeText: row.lastTradeText ?? null,
    lastTradeHour: row.lastTradeHour ?? null,
    migratedTokens: row.migratedTokens ?? null,
    migratedPct: row.migratedPct ?? null,
    raw: row.rawJson ? JSON.parse(row.rawJson) : null,
    importedAt: row.importedAt,
  })) as MigrationWalletRow[];
}
