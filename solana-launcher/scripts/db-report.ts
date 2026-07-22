#!/usr/bin/env node
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const PROJECT_ROOT = process.cwd();
const DB_PATH = path.join(PROJECT_ROOT, "data", "trade.db");

function parseArgs(argv: string[]) {
  const out = { limit: 5 };
  const envLimit = Number(process.env.npm_config_limit);
  if (Number.isFinite(envLimit)) {
    out.limit = Math.max(1, Math.min(Math.trunc(envLimit), 20));
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (/^\d+$/.test(arg) && i === argv.length - 1) {
      const parsed = Number(arg);
      if (Number.isFinite(parsed)) out.limit = Math.max(1, Math.min(Math.trunc(parsed), 20));
      continue;
    }

    if (arg === "--limit" && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed)) out.limit = Math.max(1, Math.min(Math.trunc(parsed), 20));
      i += 1;
    }
  }
  return out;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function countRows(db: Database.Database, tableName: string): number | null {
  if (!tableExists(db, tableName)) return null;
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${tableName}`).get() as { c: number };
  return row.c;
}

function section(title: string) {
  console.log(`\n## ${title}`);
}

function bullet(label: string, value: string | number | null | undefined) {
  console.log(`- ${label}: ${value ?? "—"}`);
}

function main() {
  const { limit } = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found: ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });
  const integrity = db.pragma("integrity_check", { simple: true }) as string;
  const foreignKeys = db.pragma("foreign_key_check") as unknown[];

  const keyTables = [
    "analyzed_mints",
    "token_trades",
    "wallet_stats",
    "wallet_token_stats",
    "dev_wallets",
    "dev_tokens",
    "migration_xlsx_files",
    "migration_token_rows",
    "migration_wallet_rows",
    "market_events",
    "apify_runs",
    "apify_sync_events",
  ];

  const counts = keyTables.map((table) => ({ table, rows: countRows(db, table) }));
  const migrationFiles = tableExists(db, "migration_xlsx_files")
    ? db.prepare(
        `SELECT workbook_kind, COUNT(*) AS files, SUM(token_rows) AS token_rows, SUM(wallet_rows) AS wallet_rows
         FROM migration_xlsx_files
         GROUP BY workbook_kind
         ORDER BY files DESC, workbook_kind ASC`
      ).all() as Array<{ workbook_kind: string; files: number; token_rows: number | null; wallet_rows: number | null }>
    : [];

  const recentImports = tableExists(db, "migration_xlsx_files")
    ? db.prepare(
        `SELECT file_name, workbook_kind, sheet_count, total_rows, token_rows, wallet_rows, imported_at
         FROM migration_xlsx_files
         ORDER BY imported_at DESC
         LIMIT ?`
      ).all(limit) as Array<{
        file_name: string;
        workbook_kind: string;
        sheet_count: number;
        total_rows: number;
        token_rows: number;
        wallet_rows: number;
        imported_at: number;
      }>
    : [];

  const topWallets = tableExists(db, "migration_wallet_rows")
    ? db.prepare(
        `SELECT wallet, pnl, roi, total_tokens, migrated_tokens
         FROM migration_wallet_rows
         ORDER BY pnl DESC
         LIMIT ?`
      ).all(limit) as Array<{ wallet: string; pnl: number | null; roi: number | null; total_tokens: number | null; migrated_tokens: number | null }>
    : [];

  const worstWallets = tableExists(db, "migration_wallet_rows")
    ? db.prepare(
        `SELECT wallet, pnl, roi, total_tokens, migrated_tokens
         FROM migration_wallet_rows
         ORDER BY pnl ASC
         LIMIT ?`
      ).all(limit) as Array<{ wallet: string; pnl: number | null; roi: number | null; total_tokens: number | null; migrated_tokens: number | null }>
    : [];

  const topTokens = tableExists(db, "migration_token_rows")
    ? db.prepare(
        `SELECT token_address, ticker, creator, current_mc, market_cap_max, total_unique_buyers
         FROM migration_token_rows
         ORDER BY COALESCE(market_cap_max, current_mc) DESC
         LIMIT ?`
      ).all(limit) as Array<{
        token_address: string;
        ticker: string | null;
        creator: string | null;
        current_mc: number | null;
        market_cap_max: number | null;
        total_unique_buyers: number | null;
      }>
    : [];

  const creatorsResolved = tableExists(db, "migration_token_rows")
    ? db.prepare(`SELECT COUNT(*) AS c FROM migration_token_rows WHERE creator IS NOT NULL AND creator != ''`).get() as { c: number }
    : { c: 0 };

  console.log(`# Database report`);
  console.log(`- DB: ${DB_PATH}`);
  console.log(`- integrity: ${integrity}`);
  console.log(`- foreign_key_check: ${foreignKeys.length === 0 ? "ok" : `${foreignKeys.length} issue(s)`}`);

  section("Core counts");
  for (const row of counts) bullet(row.table, row.rows);

  section("Migration summary");
  bullet("files imported", countRows(db, "migration_xlsx_files"));
  bullet("token rows", countRows(db, "migration_token_rows"));
  bullet("wallet rows", countRows(db, "migration_wallet_rows"));
  bullet("token rows with creator", creatorsResolved.c);

  if (migrationFiles.length > 0) {
    section("Workbook kinds");
    for (const row of migrationFiles) {
      console.log(
        `- ${row.workbook_kind}: ${row.files} file(s), ${row.token_rows ?? 0} token rows, ${row.wallet_rows ?? 0} wallet rows`
      );
    }
  }

  section("Recent imports");
  if (recentImports.length === 0) {
    console.log("- none");
  } else {
    for (const row of recentImports) {
      console.log(
        `- ${row.file_name} [${row.workbook_kind}] files=${row.sheet_count} total=${row.total_rows} tokens=${row.token_rows} wallets=${row.wallet_rows}`
      );
    }
  }

  section("Top wallets by PnL");
  if (topWallets.length === 0) {
    console.log("- none");
  } else {
    topWallets.forEach((row, index) => {
      console.log(
        `${index + 1}. ${row.wallet} | pnl=${row.pnl ?? "—"} | roi=${row.roi ?? "—"} | tokens=${row.total_tokens ?? "—"} | migrated=${row.migrated_tokens ?? "—"}`
      );
    });
  }

  section("Worst wallets by PnL");
  if (worstWallets.length === 0) {
    console.log("- none");
  } else {
    worstWallets.forEach((row, index) => {
      console.log(
        `${index + 1}. ${row.wallet} | pnl=${row.pnl ?? "—"} | roi=${row.roi ?? "—"} | tokens=${row.total_tokens ?? "—"} | migrated=${row.migrated_tokens ?? "—"}`
      );
    });
  }

  section("Top tokens by max market cap");
  if (topTokens.length === 0) {
    console.log("- none");
  } else {
    topTokens.forEach((row, index) => {
      console.log(
        `${index + 1}. ${row.ticker ?? "—"} | ${row.token_address} | creator=${row.creator ?? "—"} | mcap=${row.market_cap_max ?? row.current_mc ?? "—"} | buyers=${row.total_unique_buyers ?? "—"}`
      );
    });
  }
}

main();
