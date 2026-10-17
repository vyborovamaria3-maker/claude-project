"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { initDb } = require("./blockchain-seed-collector.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-offline-"));
try {
  fs.mkdirSync(path.join(root, "data"));
  const dbPath = path.join(root, "data", "trade.db");
  const db = new Database(dbPath);
  try {
    initDb(db);
    db.exec(`CREATE TABLE token_trades (
      mint TEXT, signature TEXT, timestamp INTEGER, trader TEXT, type TEXT,
      amount_sol REAL, amount_tokens REAL, price_sol REAL, slot INTEGER,
      quote_mint TEXT, quote_amount REAL, quote_decimals INTEGER, fee REAL, source TEXT)`);
    for (const [signature, time] of [["first", 1], ["second", 2], ["transfer-only", 3]]) {
      const event = { signature, slot: time, timestamp: time, transactionError: null,
        tokenBalanceDeltas: [{ mint: "mint", owner: "wallet", deltaRaw: "10" }] };
      db.prepare(`INSERT INTO chain_seed_events
        (kind,address,signature,block_time,slot,payload_gzip,payload_bytes,observed_at) VALUES('token','mint',?,?,?,?,1,1)`)
        .run(signature, time, time, zlib.gzipSync(JSON.stringify(event)));
      if (time < 3) db.prepare(`INSERT INTO token_trades
        (mint,signature,timestamp,trader,type,slot) VALUES('mint',?,?,'wallet','buy',?)`)
        .run(signature, time, time);
    }
  } finally { db.close(); }
  const before = fs.readFileSync(dbPath);
  const run = (limit) => {
    const result = spawnSync(process.execPath,
      [path.join(__dirname, "blockchain-trade-reconcile.cjs"), "mint", String(limit)],
      { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const limited = run(1);
  assert.equal(limited.normalizedTradeCount, 1);
  assert.equal(limited.tradeLimitReached, true);
  assert.deepEqual(limited.eventsWithMintDeltaNoTrade, ["transfer-only"]);
  const exact = run(2);
  assert.equal(exact.tradeLimitReached, false, "exactly filling the limit is not truncation");
  assert.deepEqual(exact.eventsWithMintDeltaNoTrade, ["transfer-only"]);
  assert.equal(exact.historyComplete, false);
  assert.deepEqual(fs.readFileSync(dbPath), before, "CLI must not modify the source database");
  console.log("[blockchain-trade-reconcile] OK: SQLite CLI limits and read-only evidence");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
