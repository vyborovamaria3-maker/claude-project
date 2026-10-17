#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initDb, claimOne, processOne, failTask, appendDiscovered } = require("./blockchain-seed-collector.cjs");
const WALLET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "11111111111111111111111111111111";
const OTHER = "So11111111111111111111111111111111111111112";
async function main() {
  const db = new Database(":memory:");
  try {
    initDb(db);
    db.prepare("INSERT INTO chain_seed_targets(kind,address,source_mask) VALUES ('wallet',?,4)").run(WALLET);
    const cfg = { recentLimit: 10, backfillLimit: 10 };
    const event = { signature: "observed", timestamp: 100 };
    const api = { fetchEnrichedTxsForMintWithMeta: async () => ({ transactions: [event], exhausted: true }),
      txsToTrades: () => [], persistTokenTrades: () => {}, markTokenTradeChecked: () => {} };
    const first = claimOne(db);
    assert(first.lease_until > Date.now());
    assert.equal(claimOne(db), null, "leased target cannot be claimed twice");
    db.prepare("UPDATE chain_seed_targets SET lease_until=1").run();
    const replacement = claimOne(db);
    // Tests can claim within the same millisecond; use a distinct lease value.
    replacement.lease_until += 1;
    db.prepare("UPDATE chain_seed_targets SET lease_until=?").run(replacement.lease_until);
    await assert.rejects(processOne(db, first, cfg, api), /stale result rejected/);
    failTask(db, first, new Error("stale failure"));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_seed_events").get().n, 0);
    assert.equal(db.prepare("SELECT lease_until,last_error FROM chain_seed_targets").get().lease_until, replacement.lease_until);
    assert.equal(db.prepare("SELECT last_error FROM chain_seed_targets").get().last_error, null);
    await processOne(db, replacement, cfg, api);
    const state = db.prepare("SELECT * FROM chain_seed_targets").get();
    assert.equal(state.events_saved, 1);
    assert.equal(state.backfill_complete, 1);
    assert.equal(state.lease_until, null);
    assert(state.last_success_at > 0);
    // Failing normalized writes roll back raw evidence and progress together.
    db.prepare("DELETE FROM chain_seed_targets").run();
    db.prepare("INSERT INTO chain_seed_targets(kind,address,source_mask) VALUES ('token',?,1)").run(TOKEN);
    const token = claimOne(db);
    const broken = { ...api, txsToTrades: () => [{ signature: "observed" }],
      persistTokenTrades: () => { throw new Error("normalization failed"); } };
    await assert.rejects(processOne(db, token, cfg, broken), /normalization failed/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_seed_events WHERE kind='token'").get().n, 0);
    assert.equal(db.prepare("SELECT last_success_at FROM chain_seed_targets").get().last_success_at, null);
    failTask(db, token, new Error("retry"));
    assert.equal(db.prepare("SELECT attempts FROM chain_seed_targets").get().attempts, 1);
    db.prepare("UPDATE chain_seed_targets SET next_run_at=0").run();
    const retry = claimOne(db);
    db.exec("CREATE TABLE normalized_fixture(signature TEXT); CREATE TRIGGER reject_progress BEFORE UPDATE OF last_success_at ON chain_seed_targets BEGIN SELECT RAISE(ABORT,'progress failed'); END");
    const normalizedApi = { ...api, txsToTrades: () => [{ signature: "observed" }],
      persistTokenTrades: () => db.prepare("INSERT INTO normalized_fixture VALUES (?)").run("observed") };
    await assert.rejects(processOne(db, retry, cfg, normalizedApi), /progress failed/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_seed_events WHERE kind='token'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM normalized_fixture").get().n, 0);
    assert.equal(db.prepare("SELECT last_success_at FROM chain_seed_targets").get().last_success_at, null);
    db.exec("DROP TRIGGER reject_progress");
    const discovered = { signature: "discover", events: { swap: { tokenOutputs: [{ mint: TOKEN }] } } };
    assert.equal(appendDiscovered(db, WALLET, [discovered], () => [{ type: "buy", trader: OTHER }]), 0);
    assert.equal(appendDiscovered(db, WALLET, [discovered], () => [{ type: "buy", trader: WALLET }]), 1);
    console.log("[blockchain-seed-persistence] OK: stale worker fencing, atomic evidence/progress, rollback, retry and owner-bound discovery");
  } finally { db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
