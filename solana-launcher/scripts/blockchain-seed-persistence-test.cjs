"use strict";
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initDb, claimOne, processOne, failTask } = require("./blockchain-seed-collector.cjs");

(async () => {
  // A database created by the Helius-cursor implementation must be revalidated
  // before Alchemy collection: signature cursors are not Alchemy pagination tokens.
  const legacyDb = new Database(":memory:");
  try {
    legacyDb.exec(`
      CREATE TABLE chain_seed_targets (
        kind TEXT NOT NULL, address TEXT NOT NULL, source_mask INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER NOT NULL DEFAULT 0,
        last_success_at INTEGER, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, backfill_cursor TEXT, backfill_complete INTEGER NOT NULL DEFAULT 0,
        possible_gap INTEGER NOT NULL DEFAULT 0, events_saved INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(kind,address)
      );
      INSERT INTO chain_seed_targets(kind,address,source_mask,priority,backfill_cursor,backfill_complete)
      VALUES('token','legacy-mint',1,100,'old-helius-signature',1);
    `);
    initDb(legacyDb);
    const migrated = legacyDb.prepare("SELECT * FROM chain_seed_targets WHERE address='legacy-mint'").get();
    assert.equal(migrated.backfill_cursor, null);
    assert.equal(migrated.forward_cursor, null);
    assert.equal(migrated.backfill_complete, 0);
    assert.equal(migrated.collection_provider, "alchemy");
    assert.equal(migrated.cursor_version, 1);
  } finally {
    legacyDb.close();
  }

  const db = new Database(":memory:");
  try {
    initDb(db);
    db.prepare("INSERT INTO chain_seed_targets(kind,address,source_mask,priority) VALUES('token','mint',1,100)").run();
    const cfg = { recentLimit: 10, backfillLimit: 10 };
    const event = { signature: "sig", timestamp: 100, slot: 1 };
    const api = {
      fetchTransactionsForAddress: async () => ({ transactions: [event], exhausted: true, nextCursor: null, source: 'alchemy' }),
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
    db.exec("CREATE TABLE normalized_fixture(signature TEXT); CREATE TRIGGER reject_progress BEFORE UPDATE OF last_success_at ON chain_seed_targets BEGIN SELECT RAISE(ABORT,'progress failed'); END");
    const normalizedApi = { ...api, txsToTrades: () => [{ signature: 'sig' }],
      markTokenTradeChecked: () => db.prepare('INSERT INTO normalized_fixture VALUES (?)').run('sig') };
    await assert.rejects(processOne(db, row, cfg, normalizedApi), /progress failed/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM normalized_fixture').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM chain_seed_events').get().n, 0);
    db.exec('DROP TRIGGER reject_progress');
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

    // A legacy row marked complete by the old swap-only implementation must still
    // be eligible for work. Only full decoder coverage may suppress a fresh recrawl.
    db.prepare("UPDATE chain_seed_targets SET source_mask=0 WHERE kind='token'").run();
    db.prepare("UPDATE chain_seed_targets SET source_mask=1,next_run_at=0,lease_until=NULL WHERE kind='wallet'").run();
    db.prepare(`
      INSERT INTO chain_wallet_discovery(wallet, first_discovered_at, history_status,
        last_fetched_at, last_trade_at, decoder_coverage)
      VALUES('wallet', ?, 'complete', ?, ?, 'swap_only')
      ON CONFLICT(wallet) DO UPDATE SET history_status='complete',
        last_fetched_at=excluded.last_fetched_at, last_trade_at=excluded.last_trade_at,
        decoder_coverage='swap_only'
    `).run(Date.now(), Date.now() - 1000, Math.floor(Date.now() / 1000));
    assert.equal(claimOne(db).kind, "wallet",
      "legacy swap-only complete status must not suppress a wallet crawl");
    db.prepare("UPDATE chain_seed_targets SET lease_until=NULL,next_run_at=0 WHERE kind='wallet'").run();
    db.prepare("UPDATE chain_wallet_discovery SET decoder_coverage='full',history_status='complete',last_fetched_at=? WHERE wallet='wallet'")
      .run(Date.now());
    initDb(db);
    assert.equal(db.prepare("SELECT history_status FROM chain_wallet_discovery WHERE wallet='wallet'").get().history_status, 'complete',
      'idempotent initialization must preserve validated history after provider migration');
    assert.equal(claimOne(db), null,
      "fresh complete full-coverage wallet history should avoid another API crawl");
    console.log("[blockchain-seed-persistence] OK: lease fencing, atomic persistence, decoder coverage scheduler gate");
  } finally { db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

require("./blockchain-trade-reconcile-test.cjs");
