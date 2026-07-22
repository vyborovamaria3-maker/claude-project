#!/usr/bin/env node
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const PROJECT_ROOT = process.cwd();
const DB_PATH = path.join(PROJECT_ROOT, "data", "trade.db");

type ParsedArgs = {
  limit: number;
  filePath: string | null;
  json: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    limit: 10,
    filePath: null,
    json: false,
  };

  const envLimit = Number(process.env.npm_config_limit);
  if (Number.isFinite(envLimit)) {
    args.limit = Math.max(1, Math.min(Math.trunc(envLimit), 100));
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (/^\d+$/.test(arg) && i === argv.length - 1) {
      const parsed = Number(arg);
      if (Number.isFinite(parsed)) args.limit = Math.max(1, Math.min(Math.trunc(parsed), 100));
      continue;
    }

    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--limit" && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed)) args.limit = Math.max(1, Math.min(Math.trunc(parsed), 100));
      i += 1;
      continue;
    }
    if (arg === "--file-path" && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      args.filePath = argv[i + 1];
      i += 1;
      continue;
    }
  }

  return args;
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

function topRows<T extends Record<string, unknown>>(rows: T[], limit: number): T[] {
  return rows.slice(0, limit);
}

function printSection(title: string) {
  console.log(`\n== ${title} ==`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found: ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });

  const integrity = db.pragma("integrity_check", { simple: true }) as string;
  const foreignKeys = db.pragma("foreign_key_check") as unknown[];
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;

  const tableCounts = tables.map(({ name }) => ({
    table: name,
    rows: countRows(db, name),
  }));

  const duplicateChecks: Record<string, unknown[]> = {};
  const checkDuplicate = (key: string, sql: string, params: unknown[] = []) => {
    try {
      duplicateChecks[key] = db.prepare(sql).all(...params) as unknown[];
    } catch {
      duplicateChecks[key] = [];
    }
  };

  checkDuplicate(
    "migration_token_rows",
    `SELECT file_path, sheet_name, row_index, COUNT(*) AS duplicates
     FROM migration_token_rows
     GROUP BY file_path, sheet_name, row_index
     HAVING COUNT(*) > 1
     ORDER BY duplicates DESC, file_path ASC
     LIMIT 20`
  );
  checkDuplicate(
    "migration_wallet_rows",
    `SELECT file_path, sheet_name, row_index, COUNT(*) AS duplicates
     FROM migration_wallet_rows
     GROUP BY file_path, sheet_name, row_index
     HAVING COUNT(*) > 1
     ORDER BY duplicates DESC, file_path ASC
     LIMIT 20`
  );
  checkDuplicate(
    "token_trades",
    `SELECT mint, signature, COUNT(*) AS duplicates
     FROM token_trades
     GROUP BY mint, signature
     HAVING COUNT(*) > 1
     ORDER BY duplicates DESC, mint ASC
     LIMIT 20`
  );
  checkDuplicate(
    "dev_tokens",
    `SELECT mint, creator, COUNT(*) AS duplicates
     FROM dev_tokens
     GROUP BY mint, creator
     HAVING COUNT(*) > 1
     ORDER BY duplicates DESC, mint ASC
     LIMIT 20`
  );
  checkDuplicate(
    "wallet_token_stats",
    `SELECT address, mint, COUNT(*) AS duplicates
     FROM wallet_token_stats
     GROUP BY address, mint
     HAVING COUNT(*) > 1
     ORDER BY duplicates DESC, address ASC
     LIMIT 20`
  );
  checkDuplicate(
    "market_events",
    `SELECT event_id, COUNT(*) AS duplicates
     FROM market_events
     GROUP BY event_id
     HAVING COUNT(*) > 1
     ORDER BY duplicates DESC, event_id ASC
     LIMIT 20`
  );
  checkDuplicate(
    "apify_runs",
    `SELECT run_id, COUNT(*) AS duplicates
     FROM apify_runs
     GROUP BY run_id
     HAVING COUNT(*) > 1
     ORDER BY duplicates DESC, run_id ASC
     LIMIT 20`
  );

  const sampleLimit = args.limit;
  const samples = {
    migrationFiles: tableExists(db, "migration_xlsx_files")
      ? db.prepare(
          `SELECT file_name, workbook_kind, sheet_count, total_rows, token_rows, wallet_rows, imported_at
           FROM migration_xlsx_files
           ORDER BY imported_at DESC
           LIMIT ?`
        ).all(sampleLimit)
      : [],
    migrationTokens: tableExists(db, "migration_token_rows")
      ? db.prepare(
          `SELECT file_name, sheet_name, token_address, ticker, creator, current_mc, market_cap_max, time_before_migration_seconds
           FROM migration_token_rows
           ORDER BY imported_at DESC, row_index ASC
           LIMIT ?`
        ).all(sampleLimit)
      : [],
    migrationWallets: tableExists(db, "migration_wallet_rows")
      ? db.prepare(
          `SELECT file_name, sheet_name, wallet, pnl, roi, total_tokens, migrated_tokens
           FROM migration_wallet_rows
           ORDER BY imported_at DESC, row_index ASC
           LIMIT ?`
        ).all(sampleLimit)
      : [],
    topWalletsByPnl: tableExists(db, "migration_wallet_rows")
      ? db.prepare(
          `SELECT wallet, pnl, roi, total_tokens, migrated_tokens
           FROM migration_wallet_rows
           ORDER BY pnl DESC
           LIMIT ?`
        ).all(sampleLimit)
      : [],
    topTokensByMarketCap: tableExists(db, "migration_token_rows")
      ? db.prepare(
          `SELECT token_address, ticker, creator, current_mc, market_cap_max, total_unique_buyers
           FROM migration_token_rows
           ORDER BY COALESCE(market_cap_max, current_mc) DESC
           LIMIT ?`
        ).all(sampleLimit)
      : [],
  };

  const report = {
    dbPath: DB_PATH,
    integrity,
    foreignKeyViolations: foreignKeys.length,
    tableCounts,
    duplicateChecks,
    samples,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`DB: ${DB_PATH}`);
  printSection("INTEGRITY");
  console.log(`integrity_check: ${integrity}`);
  console.log(`foreign_key_check: ${foreignKeys.length === 0 ? "ok" : `${foreignKeys.length} issue(s)`}`);

  printSection("COUNTS");
  for (const row of tableCounts) {
    console.log(`${row.table}: ${row.rows ?? "missing"}`);
  }

  printSection("DUPLICATES");
  for (const [key, rows] of Object.entries(duplicateChecks)) {
    console.log(`${key}: ${rows.length}`);
    if (rows.length > 0) {
      console.log(JSON.stringify(topRows(rows as Record<string, unknown>[], sampleLimit), null, 2));
    }
  }

  printSection("SAMPLES");
  console.log("migration_xlsx_files:");
  console.log(JSON.stringify(samples.migrationFiles, null, 2));
  console.log("migration_token_rows:");
  console.log(JSON.stringify(samples.migrationTokens, null, 2));
  console.log("migration_wallet_rows:");
  console.log(JSON.stringify(samples.migrationWallets, null, 2));
  console.log("top_wallets_by_pnl:");
  console.log(JSON.stringify(samples.topWalletsByPnl, null, 2));
  console.log("top_tokens_by_market_cap:");
  console.log(JSON.stringify(samples.topTokensByMarketCap, null, 2));
}

main();
