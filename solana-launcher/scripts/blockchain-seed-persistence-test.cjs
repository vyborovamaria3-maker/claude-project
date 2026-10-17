"use strict";
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initDb, claimOne, processOne, failTask } = require("./blockchain-seed-collector.cjs");

(async () => {
  const db = new Database(":memory:");
  try {
    initDb(db);
    db.prepare("INSERT INTO chain_seed_targets(kind,address,source_mask,priority) VALUES('token','mint',1,100)").run();
    const cfg = { recentLimit: 10, backfillLimit: 10 };
    const event = { signature: "sig", timestamp: 100, slot: 1 };
    const api = {
      fetchEnrichedTxsForMintWithMeta: async () => ({ transactions: [event], exhausted: true }),
      txsToTrades: () => [], persistTokenTrades: () => {}, markTokenTradeChecked: () => {},
    };
    const stale = claimOne(db);
    assert.ok(stale.lease_until > Date.now());
    db.prepare("UPDATE chain_seed_targets SET lease_until=?,backfill_cursor='new-owner'").run(stale.lease_until + 1);
    await assert.rejects(processOne(db, stale, cfg, api), /lease lost/);
    failTask(db, stale, new Error("late error"));
    const owned = db.prepare("SELECT * FROM chain_seed_targets").get();
    assert.equal(owned.lease_until, stale.lease_until + 1);
    assert.equal(owned.backfill_cursor, "new-owner");
    assert.equal(owned.attempts, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM chain_seed_events").get().n, 0);

    db.prepare("UPDATE chain_seed_targets SET lease_until=NULL,backfill_cursor=NULL").run();
    const row = claimOne(db);
    await assert.rejects(processOne(db, row, cfg, { ...api, markTokenTradeChecked() { throw new Error("projection failure"); } }), /projection failure/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM chain_seed_events").get().n, 0, "raw evidence must roll back with projection failure");
    assert.equal(db.prepare("SELECT backfill_complete FROM chain_seed_targets").get().backfill_complete, 0);
    await processOne(db, row, cfg, api);
    const saved = db.prepare("SELECT * FROM chain_seed_targets").get();
    assert.equal(saved.lease_until, null);
    assert.equal(saved.backfill_complete, 1);
    assert.equal(saved.events_saved, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM chain_seed_events").get().n, 1);
    db.prepare("INSERT INTO chain_seed_targets(kind,address,source_mask,priority) VALUES('wallet','wallet',1,100)").run();
    const wallet = claimOne(db);
    const cache = require("./blockchain-wallet-cache.cjs");
    const originalMark = cache.markWalletHistory;
    try {
      cache.markWalletHistory = () => { throw new Error("wallet status failure"); };
      await assert.rejects(processOne(db, wallet, cfg, api), /wallet status failure/);
    } finally { cache.markWalletHistory = originalMark; }
    assert.equal(db.prepare("SELECT COUNT(*) n FROM chain_seed_events WHERE kind='wallet'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM chain_wallet_discovery").get().n, 0);
    assert.equal(db.prepare("SELECT last_success_at FROM chain_seed_targets WHERE kind='wallet'").get().last_success_at, null);
    console.log("[blockchain-seed-persistence] OK: stale success/error fenced; raw/projection/progress atomic");
  } finally { db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
