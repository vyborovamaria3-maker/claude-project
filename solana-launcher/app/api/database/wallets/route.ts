import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../../../../lib/trade/db";
import { checkRateLimit, getClientIp } from "../../../../lib/rateLimit";

export const dynamic = "force-dynamic";

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW = 60;
const RESPONSE_CACHE_TTL_MS = 15_000;
const SNAPSHOT_PATH = path.join(process.cwd(), "data", "database-wallets.response-cache.json");

const SORTABLE = new Set([
  "avg_pnl",
  "avg_roi",
  "avg_wr",
  "avg_migrated_pct",
  "avg_fast_trades_pct",
  "avg_total_tokens",
  "avg_migrated_tokens",
  "total_pnl_sol",
  "total_volume_sol",
  "tokens_traded",
  "chain_win_rate",
  "bundle_rows",
  "total_rockets",
  "reports",
]);

const SORT_DIR_ALLOWED = new Set(["ASC", "DESC"]);

const SORT_SQL: Record<string, string> = {
  avg_pnl: "m.avg_pnl",
  avg_roi: "m.avg_roi",
  avg_wr: "m.avg_wr",
  avg_migrated_pct: "m.avg_migrated_pct",
  avg_fast_trades_pct: "m.avg_fast_trades_pct",
  avg_total_tokens: "m.avg_total_tokens",
  avg_migrated_tokens: "m.avg_migrated_tokens",
  total_pnl_sol: "ws.total_pnl_sol",
  total_volume_sol: "ws.total_volume_sol",
  tokens_traded: "ws.tokens_traded",
  chain_win_rate: "m.avg_pnl",
  bundle_rows: "m.avg_pnl",
  total_rockets: "m.total_rockets",
  reports: "m.reports",
};

type CachedResponse = {
  at: number;
  payload: unknown;
};

const responseCache = new Map<string, CachedResponse>();

type SnapshotEntry = {
  key: string;
  sourceSignature: string;
  at: number;
  payload: unknown;
};

function readSnapshot(): SnapshotEntry[] {
  if (!fs.existsSync(SNAPSHOT_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")) as SnapshotEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSnapshot(entries: SnapshotEntry[]) {
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(entries));
}

type WalletRow = {
  wallet: string;
  avg_pnl: number | null;
  avg_roi: number | null;
  avg_wr: number | null;
  avg_migrated_pct: number | null;
  avg_fast_trades_pct: number | null;
  avg_total_tokens: number | null;
  avg_migrated_tokens: number | null;
  total_rockets: number | null;
  reports: number | null;
  total_volume_sol: number | null;
  total_pnl_sol: number | null;
  tokens_traded: number | null;
  total_buys: number | null;
  total_sells: number | null;
  first_seen: number | null;
  last_updated_at: number | null;
  chain_win_rate: number | null;
  fresh_rate: number | null;
  wash_rate: number | null;
  bundle_rows: number | null;
  positive_token_rows: number | null;
  wallet_token_rows: number | null;
  wallet_tokens_updated_at: number | null;
  tags: string | null;
};

type ParsedTokenRow = {
  token_address: string;
  ticker: string | null;
  creator: string | null;
  creator_source: string | null;
  file_name: string | null;
  sheet_name: string | null;
  first_row_index: number | null;
  total_unique_buyers: number | null;
  current_mc: number | null;
  market_cap_max: number | null;
  mint_time_text: string | null;
  migration_time_text: string | null;
  time_before_migration_seconds: number | null;
  symbol: string | null;
  name: string | null;
  twitter: string | null;
  created_at: number | null;
  is_migrated: number | null;
  reached_300k: number | null;
  total_trades: number | null;
  buy_trades: number | null;
  sell_trades: number | null;
  unique_traders: number | null;
  trade_volume_sol: number | null;
  first_trade_at: number | null;
  last_trade_at: number | null;
};

function ensureWalletSummary(db: ReturnType<typeof getDb>) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS database_wallet_summary (
      wallet TEXT PRIMARY KEY,
      avg_pnl REAL,
      avg_roi REAL,
      avg_wr REAL,
      avg_migrated_pct REAL,
      avg_fast_trades_pct REAL,
      avg_total_tokens REAL,
      avg_migrated_tokens REAL,
      total_rockets INTEGER,
      reports INTEGER,
      source_signature TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_database_wallet_summary_pnl ON database_wallet_summary(avg_pnl DESC);
    CREATE INDEX IF NOT EXISTS idx_database_wallet_summary_roi ON database_wallet_summary(avg_roi DESC);
    CREATE INDEX IF NOT EXISTS idx_database_wallet_summary_wr ON database_wallet_summary(avg_wr DESC);
    CREATE INDEX IF NOT EXISTS idx_database_wallet_summary_migrated ON database_wallet_summary(avg_migrated_pct DESC);
    CREATE INDEX IF NOT EXISTS idx_database_wallet_summary_reports ON database_wallet_summary(reports DESC);
    CREATE TABLE IF NOT EXISTS database_wallet_summary_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const source = db.prepare(`
    SELECT
      COALESCE(MAX(rowid), 0) AS max_rowid
    FROM migration_wallet_rows
  `).get() as { max_rowid: number };
  const sourceSignature = `${source.max_rowid}`;
  const stored = db.prepare("SELECT value FROM database_wallet_summary_meta WHERE key = 'source_signature'").get() as { value: string } | undefined;
  if (stored?.value === sourceSignature) return;
  if (stored?.value.endsWith(`:${source.max_rowid}`)) {
    db.prepare(`
      INSERT INTO database_wallet_summary_meta (key, value)
      VALUES ('source_signature', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(sourceSignature);
    return;
  }

  const rebuild = db.transaction(() => {
    db.prepare("DELETE FROM database_wallet_summary").run();
    db.prepare(`
      INSERT INTO database_wallet_summary (
        wallet,
        avg_pnl,
        avg_roi,
        avg_wr,
        avg_migrated_pct,
        avg_fast_trades_pct,
        avg_total_tokens,
        avg_migrated_tokens,
        total_rockets,
        reports,
        source_signature
      )
      SELECT
        wallet,
        AVG(pnl) AS avg_pnl,
        AVG(roi) AS avg_roi,
        AVG(wr) AS avg_wr,
        AVG(migrated_pct) AS avg_migrated_pct,
        AVG(fast_trades_pct) AS avg_fast_trades_pct,
        AVG(total_tokens) AS avg_total_tokens,
        AVG(migrated_tokens) AS avg_migrated_tokens,
        SUM(COALESCE(rockets, 0)) AS total_rockets,
        COUNT(*) AS reports,
        ? AS source_signature
      FROM migration_wallet_rows
      WHERE wallet IS NOT NULL AND wallet != ''
      GROUP BY wallet
    `).run(sourceSignature);
    db.prepare(`
      INSERT INTO database_wallet_summary_meta (key, value)
      VALUES ('source_signature', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(sourceSignature);
  });

  rebuild();
}

function getSourceSignature(db: ReturnType<typeof getDb>) {
  const rows = db.prepare(`
    SELECT
      (SELECT COALESCE(MAX(rowid), 0) FROM migration_wallet_rows) AS migration_wallet_rows,
      (SELECT COALESCE(MAX(rowid), 0) FROM wallet_stats) AS wallet_stats,
      (SELECT COALESCE(MAX(rowid), 0) FROM wallet_tags) AS wallet_tags,
      (SELECT COALESCE(MAX(rowid), 0) FROM wallet_token_stats) AS wallet_token_stats,
      (SELECT COALESCE(MAX(rowid), 0) FROM migration_token_rows) AS migration_token_rows,
      (SELECT COALESCE(MAX(rowid), 0) FROM token_trades) AS token_trades
  `).get() as Record<string, number>;
  return Object.values(rows).join(":");
}

export async function GET(req: NextRequest) {
  const clientIp = getClientIp(req as unknown as Request);
  const rateLimit = checkRateLimit(clientIp, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);

  if (!rateLimit.success) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later.", retryAfter: rateLimit.retryAfter },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(rateLimit.limit),
          "X-RateLimit-Remaining": String(rateLimit.remaining),
          "X-RateLimit-Reset": String(rateLimit.reset),
          "Retry-After": String(rateLimit.retryAfter || 60),
        },
      },
    );
  }

  const { searchParams } = new URL(req.url);
  const minPnl = parseFloat(searchParams.get("minPnl") || "");
  const minRoi = parseFloat(searchParams.get("minRoi") || "");
  const minWr = parseFloat(searchParams.get("minWr") || "");
  const minMigrated = parseFloat(searchParams.get("minMigrated") || "");
  const minTokens = parseFloat(searchParams.get("minTokens") || "");
  const minReports = parseFloat(searchParams.get("minReports") || "");
  const search = (searchParams.get("search") || "").trim();
  const tag = (searchParams.get("tag") || "").trim();
  const sortByRaw = (searchParams.get("sortBy") || "avg_pnl").trim();
  const sortDirRaw = (searchParams.get("sortDir") || "desc").trim().toUpperCase();
  const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10) || 100, 500);
  const offset = Math.max(parseInt(searchParams.get("offset") || "0", 10) || 0, 0);
  const sortBy = SORTABLE.has(sortByRaw) ? sortByRaw : "avg_pnl";
  const sortExpr = SORT_SQL[sortBy] ?? SORT_SQL.avg_pnl;
  const sortDir = SORT_DIR_ALLOWED.has(sortDirRaw) ? sortDirRaw : "DESC";
  const cacheKey = `${searchParams.toString()}|${sortBy}|${sortDir}`;
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RESPONSE_CACHE_TTL_MS) {
    return NextResponse.json(cached.payload, {
      headers: {
        "Cache-Control": `public, max-age=0, s-maxage=${Math.floor(RESPONSE_CACHE_TTL_MS / 1000)}`,
      },
    });
  }

  const db = getDb();
  ensureWalletSummary(db);
  const sourceSignature = getSourceSignature(db);
  const snapshotEntries = readSnapshot();
  const snapshotHit = snapshotEntries.find((entry) => entry.key === cacheKey && entry.sourceSignature === sourceSignature && Date.now() - entry.at < 5 * 60 * 1000);
  if (snapshotHit) {
    responseCache.set(cacheKey, { at: snapshotHit.at, payload: snapshotHit.payload });
    return NextResponse.json(snapshotHit.payload, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=300",
      },
    });
  }
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (tag) {
    where.push("EXISTS (SELECT 1 FROM wallet_tags tag_filter WHERE tag_filter.wallet = m.wallet AND tag_filter.tag = ?)");
    params.push(tag);
  }
  if (search) {
    where.push("m.wallet LIKE ?");
    params.push(`%${search}%`);
  }
  if (Number.isFinite(minPnl)) {
    where.push("m.avg_pnl >= ?");
    params.push(minPnl);
  }
  if (Number.isFinite(minRoi)) {
    where.push("m.avg_roi >= ?");
    params.push(minRoi);
  }
  if (Number.isFinite(minWr)) {
    where.push("m.avg_wr >= ?");
    params.push(minWr);
  }
  if (Number.isFinite(minMigrated)) {
    where.push("m.avg_migrated_pct >= ?");
    params.push(minMigrated);
  }
  if (Number.isFinite(minReports)) {
    where.push("m.reports >= ?");
    params.push(minReports);
  }
  if (Number.isFinite(minTokens)) {
    where.push("m.avg_total_tokens >= ?");
    params.push(minTokens);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT
      m.wallet,
      m.avg_pnl,
      m.avg_roi,
      m.avg_wr,
      m.avg_migrated_pct,
      m.avg_fast_trades_pct,
      m.avg_total_tokens,
      m.avg_migrated_tokens,
      m.total_rockets,
      m.reports,
      ws.total_volume_sol,
      ws.total_pnl_sol,
      ws.tokens_traded,
      ws.total_buys,
      ws.total_sells,
      ws.first_seen,
      ws.last_updated_at,
      NULL AS chain_win_rate,
      NULL AS fresh_rate,
      NULL AS wash_rate,
      NULL AS bundle_rows,
      NULL AS positive_token_rows,
      NULL AS wallet_token_rows,
      NULL AS wallet_tokens_updated_at,
      GROUP_CONCAT(DISTINCT wt.tag) AS tags
    FROM database_wallet_summary m
    LEFT JOIN wallet_stats ws ON ws.address = m.wallet
    LEFT JOIN wallet_tags wt ON wt.wallet = m.wallet
    ${whereSql}
    GROUP BY m.wallet
    ORDER BY (${sortExpr} IS NULL) ASC, ${sortExpr} ${sortDir}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as WalletRow[];

  const tokenStatsByWallet = new Map<string, Partial<WalletRow>>();
  if (rows.length > 0) {
    const placeholders = rows.map(() => "?").join(",");
    const tokenRows = db.prepare(`
      SELECT
        address AS wallet,
        AVG(CASE WHEN pnl_sol > 0 THEN 1.0 ELSE 0.0 END) AS chain_win_rate,
        AVG(CASE WHEN is_fresh = 1 THEN 1.0 ELSE 0.0 END) AS fresh_rate,
        AVG(CASE WHEN is_wash = 1 THEN 1.0 ELSE 0.0 END) AS wash_rate,
        SUM(CASE WHEN bundle_id IS NOT NULL THEN 1 ELSE 0 END) AS bundle_rows,
        SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) AS positive_token_rows,
        COUNT(*) AS wallet_token_rows,
        MAX(updated_at) AS wallet_tokens_updated_at
      FROM wallet_token_stats
      WHERE address IN (${placeholders})
      GROUP BY address
    `).all(...rows.map((row) => row.wallet)) as Array<Partial<WalletRow> & { wallet: string }>;
    for (const row of tokenRows) tokenStatsByWallet.set(row.wallet, row);
  }

  const items = rows.map((r) => {
    const tokenStats = tokenStatsByWallet.get(r.wallet);
    return ({
    wallet: r.wallet,
    avgPnl: r.avg_pnl,
    avgRoi: r.avg_roi,
    avgWr: r.avg_wr,
    avgMigratedPct: r.avg_migrated_pct,
    avgFastTradesPct: r.avg_fast_trades_pct,
    avgTotalTokens: r.avg_total_tokens,
    avgMigratedTokens: r.avg_migrated_tokens,
    totalRockets: r.total_rockets,
    reports: r.reports,
    totalVolumeSol: r.total_volume_sol,
    totalPnlSol: r.total_pnl_sol,
    tokensTraded: r.tokens_traded,
    totalBuys: r.total_buys,
    totalSells: r.total_sells,
    firstSeen: r.first_seen,
    lastUpdatedAt: r.last_updated_at,
    chainWinRate: tokenStats?.chain_win_rate ?? null,
    freshRate: tokenStats?.fresh_rate ?? null,
    washRate: tokenStats?.wash_rate ?? null,
    bundleRows: tokenStats?.bundle_rows ?? null,
    positiveTokenRows: tokenStats?.positive_token_rows ?? null,
    walletTokenRows: tokenStats?.wallet_token_rows ?? null,
    walletTokensUpdatedAt: tokenStats?.wallet_tokens_updated_at ?? null,
    tags: Array.from(new Set((r.tags || "").split(",").filter(Boolean))),
    });
  });

  const totalsRow = db
    .prepare("SELECT COUNT(*) AS n FROM database_wallet_summary")
    .get() as { n: number };

  const tokenTotalsRow = db
    .prepare("SELECT COUNT(*) AS n FROM migration_token_rows WHERE token_address IS NOT NULL AND token_address != ''")
    .get() as { n: number };

  const tagBreakdown = db
    .prepare("SELECT tag, COUNT(*) AS count FROM wallet_tags GROUP BY tag ORDER BY count DESC")
    .all() as Array<{ tag: string; count: number }>;

  const parsedTokens = db.prepare(`
    WITH parsed_base AS (
      SELECT
        token_address,
        ticker,
        creator,
        creator_source,
        file_name,
        sheet_name,
        row_index AS first_row_index,
        total_unique_buyers,
        current_mc,
        market_cap_max,
        mint_time_text,
        migration_time_text,
        time_before_migration_seconds
      FROM migration_token_rows
      WHERE token_address IS NOT NULL AND token_address != ''
      ORDER BY id DESC
      LIMIT 100
    ),
    trade_rollup AS (
      SELECT
        mint,
        COUNT(*) AS total_trades,
        SUM(CASE WHEN type = 'buy' THEN 1 ELSE 0 END) AS buy_trades,
        SUM(CASE WHEN type = 'sell' THEN 1 ELSE 0 END) AS sell_trades,
        COUNT(DISTINCT trader) AS unique_traders,
        SUM(amount_sol) AS trade_volume_sol,
        MIN(timestamp) AS first_trade_at,
        MAX(timestamp) AS last_trade_at
      FROM token_trades
      WHERE mint IN (SELECT token_address FROM parsed_base)
      GROUP BY mint
    )
    SELECT
      m.token_address,
      m.ticker,
      m.creator,
      m.creator_source,
      m.file_name,
      m.sheet_name,
      m.first_row_index,
      m.total_unique_buyers,
      m.current_mc,
      m.market_cap_max,
      m.mint_time_text,
      m.migration_time_text,
      m.time_before_migration_seconds,
      dt.symbol,
      dt.name,
      dt.twitter,
      dt.created_at,
      dt.is_migrated,
      dt.reached_300k,
      tr.total_trades,
      tr.buy_trades,
      tr.sell_trades,
      tr.unique_traders,
      tr.trade_volume_sol,
      tr.first_trade_at,
      tr.last_trade_at
    FROM parsed_base m
    LEFT JOIN dev_tokens dt ON dt.mint = m.token_address
    LEFT JOIN trade_rollup tr ON tr.mint = m.token_address
    ORDER BY m.first_row_index ASC
  `).all() as ParsedTokenRow[];
  const payload = {
    items,
    totalTagged: totalsRow.n,
    totalWallets: totalsRow.n,
    totalParsedTokens: tokenTotalsRow.n,
    tagBreakdown,
    parsedTokens: parsedTokens.map((row) => ({
      mint: row.token_address,
      ticker: row.ticker,
      symbol: row.symbol,
      name: row.name,
      creator: row.creator,
      creatorSource: row.creator_source,
      fileName: row.file_name,
      sheetName: row.sheet_name,
      firstRowIndex: row.first_row_index,
      totalUniqueBuyers: row.total_unique_buyers,
      currentMc: row.current_mc,
      marketCapMax: row.market_cap_max,
      mintTimeText: row.mint_time_text,
      migrationTimeText: row.migration_time_text,
      timeBeforeMigrationSeconds: row.time_before_migration_seconds,
      twitter: row.twitter,
      createdAt: row.created_at,
      isMigrated: Boolean(row.is_migrated),
      reached300k: Boolean(row.reached_300k),
      tokenVolumeSol: null,
      tokenVolumeUsd: null,
      totalTrades: row.total_trades,
      buyTrades: row.buy_trades,
      sellTrades: row.sell_trades,
      uniqueTraders: row.unique_traders,
      tradeVolumeSol: row.trade_volume_sol,
      firstTradeAt: row.first_trade_at,
      lastTradeAt: row.last_trade_at,
    })),
    page: { limit, offset, returned: items.length },
    filters: { minPnl, minRoi, minWr, minMigrated, minTokens, minReports, search, tag, sortBy, sortDir },
  };

  responseCache.set(cacheKey, { at: Date.now(), payload });
  const nextEntries = snapshotEntries.filter((entry) => !(entry.key === cacheKey && entry.sourceSignature === sourceSignature));
  nextEntries.unshift({ key: cacheKey, sourceSignature, at: Date.now(), payload });
  writeSnapshot(nextEntries.slice(0, 40));

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "public, max-age=0, s-maxage=300",
    },
  });
}
