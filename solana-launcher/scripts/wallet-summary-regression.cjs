#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

require("ts-node").register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: {
    module: "commonjs",
    moduleResolution: "node",
    esModuleInterop: true,
    allowJs: true,
    resolveJsonModule: true,
  },
});

const fs = require("node:fs");
const path = require("node:path");
const { getWalletSummaryStatus, rebuildWalletSummary, parseWalletPageSize, parseWalletPageOffset } = require("../lib/trade/wallet-summary.ts");
const db = new Database(":memory:");

try {
  db.exec(`
    CREATE TABLE migration_wallet_rows (
      wallet TEXT,
      pnl REAL,
      roi REAL,
      wr REAL,
      migrated_pct REAL,
      fast_trades_pct REAL,
      total_tokens REAL,
      migrated_tokens REAL,
      rockets INTEGER
    );
    CREATE TABLE database_source_revisions (
      name TEXT PRIMARY KEY,
      revision INTEGER NOT NULL
    );
    INSERT INTO database_source_revisions(name, revision) VALUES ('migration_wallet_rows', 1);
    INSERT INTO migration_wallet_rows VALUES
      ('wallet-A', 10, 1.0, 0.5, 20, 10, 4, 2, 1),
      ('wallet-A', 20, 2.0, 0.7, 40, 20, 6, 4, 2),
      ('wallet-B', -5, -0.5, 0.2, 0, 0, 1, 0, 0);
  `);

  assert.equal(getWalletSummaryStatus(db).ready, false, "summary must start uninitialized");
  assert.equal(parseWalletPageSize("-1"), 1, "negative page sizes must not disable SQLite LIMIT");
  assert.equal(parseWalletPageSize("0"), 1, "zero page size must be clamped");
  assert.equal(parseWalletPageSize("9999"), 500, "page size must respect its maximum");
  assert.equal(parseWalletPageSize("invalid"), 100, "invalid page size must use the default");
  assert.equal(parseWalletPageOffset("-1"), 0, "negative offsets must be rejected");
  assert.equal(parseWalletPageOffset("1000000"), 100000, "offset must respect its maximum");

  const walletRoute = fs.readFileSync(path.join(__dirname, "../app/api/database/wallets/route.ts"), "utf8");
  assert.match(walletRoute, /chain_win_rate: "token_rollup\.chain_win_rate"/);
  assert.match(walletRoute, /bundle_rows: "token_rollup\.bundle_rows"/);
  assert.match(walletRoute, /MAX_RESPONSE_CACHE_ENTRIES = 100/);

  const first = rebuildWalletSummary(db);
  assert.equal(first.rebuilt, true);
  assert.equal(first.rows, 2);
  assert.equal(getWalletSummaryStatus(db).ready, true);

  const walletA = db.prepare("SELECT avg_pnl, reports, total_rockets FROM database_wallet_summary WHERE wallet = ?").get("wallet-A");
  assert.equal(walletA.avg_pnl, 15);
  assert.equal(walletA.reports, 2);
  assert.equal(walletA.total_rockets, 3);

  db.prepare("INSERT INTO migration_wallet_rows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "wallet-B", 5, 0.5, 0.4, 10, 5, 2, 1, 1
  );
  db.prepare("UPDATE database_source_revisions SET revision = revision + 1 WHERE name = 'migration_wallet_rows'").run();
  assert.equal(getWalletSummaryStatus(db).ready, false, "new source revision must invalidate the summary");

  const second = rebuildWalletSummary(db);
  assert.equal(second.rebuilt, true);
  assert.equal(second.rows, 2);
  assert.equal(getWalletSummaryStatus(db).ready, true);

  const walletB = db.prepare("SELECT avg_pnl, reports FROM database_wallet_summary WHERE wallet = ?").get("wallet-B");
  assert.equal(walletB.avg_pnl, 0);
  assert.equal(walletB.reports, 2);

  const noOp = rebuildWalletSummary(db);
  assert.equal(noOp.rebuilt, false, "rebuild must be a no-op when the source signature is current");
  assert.equal(getWalletSummaryStatus(db).ready, true);

  console.log("Wallet summary rebuild is explicit, revision-aware, idempotent and returns correct aggregates.");
} finally {
  db.close();
}
