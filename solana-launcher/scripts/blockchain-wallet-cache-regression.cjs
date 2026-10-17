#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const cache = require("./blockchain-wallet-cache.cjs");

const WALLET = "11111111111111111111111111111111";
const MINT_A = "So11111111111111111111111111111111111111112";
const MINT_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const db = new Database(":memory:");
try {
  cache.ensureWalletCacheSchema(db);
  const event = {
    signature: "sig-1",
    timestamp: 1_800_000_000,
    slot: 123,
    events: { swap: { tokenInputs: [{ mint: MINT_A }], tokenOutputs: [{ mint: MINT_B }] } }
  };
  const decoder = (_events, mint) => mint === MINT_A ? [{
    signature: "sig-1", timestamp: event.timestamp, slot: event.slot,
    type: "buy", amountSol: 1.25, amountTokens: 100, fee: 0.000005
  }] : [];

  const first = cache.cacheWalletTrades(db, WALLET, [event], decoder, { now: 1000 });
  assert.deepEqual(first.tokenMints, [MINT_A]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_wallet_trades").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_wallet_token_touched").get().n, 1);
  assert.equal(db.prepare("SELECT bought_amount FROM chain_wallet_token_summary WHERE wallet=? AND token_mint=?")
    .get(WALLET, MINT_A).bought_amount, "100");

  const replay = cache.cacheWalletTrades(db, WALLET, [event], decoder, { now: 2000 });
  assert.equal(replay.upserted, 1, "idempotent upsert must preserve a single leg");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_wallet_trades").get().n, 1);
  assert.equal(db.prepare("SELECT trades_count FROM chain_wallet_token_summary WHERE wallet=? AND token_mint=?")
    .get(WALLET, MINT_A).trades_count, 1);

  cache.markWalletHistory(db, WALLET, {
    complete: true, backfillCursor: null, forwardCursor: null, possibleGap: false, now: 3000
  });
  assert.equal(cache.walletHistoryFresh(db, WALLET, 4000), true,
    "fresh complete wallet history should be reusable without RPC");
  cache.markWalletHistory(db, WALLET, {
    complete: false, backfillCursor: "cursor-1", forwardCursor: null, possibleGap: false, now: 5000
  });
  assert.equal(cache.walletHistoryFresh(db, WALLET, 6000), false,
    "partial history must never be considered reusable as complete");

  const discovery = db.prepare("SELECT history_status, backfill_cursor FROM chain_wallet_discovery WHERE wallet=?").get(WALLET);
  assert.equal(discovery.history_status, "partial");
  assert.equal(discovery.backfill_cursor, "cursor-1");
  console.log("[blockchain-wallet-cache-regression] OK: idempotency, summaries, complete-history reuse, partial resume state");
} finally {
  db.close();
}
