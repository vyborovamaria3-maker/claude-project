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
    events: { swap: { tokenInputs: [{ mint: MINT_A, userAccount: WALLET }], tokenOutputs: [{ mint: MINT_B, userAccount: WALLET }] } }
  };
  const decoder = (_events, mint) => mint === MINT_A ? [
    { signature: "sig-1", timestamp: event.timestamp, slot: event.slot,
      trader: WALLET, type: "buy", amountSol: 1.25, amountTokens: 100, fee: 0.000005 },
    { signature: "sig-1", timestamp: event.timestamp, slot: event.slot,
      trader: WALLET, type: "buy", amountSol: 0.25, amountTokens: 50, fee: 0.000005 }
  ] : [];

  const first = cache.cacheWalletTrades(db, WALLET, [event], decoder, { now: 1000 });
  const rejected = cache.cacheWalletTrades(db, WALLET,
    [{ ...event, signature: "failed-swap", transactionError: { InstructionError: [0, "failed"] } }],
    () => { throw new Error("failed transaction must not reach decoder"); });
  assert.equal(rejected.upserted, 0);
  assert.deepEqual(first.tokenMints, [MINT_A]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_wallet_trades").get().n, 2,
    "distinct swap legs in the same signature must both be retained");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_wallet_token_touched").get().n, 2);
  const evidence = db.prepare("SELECT signature, raw_event_signature, slot, raw_event_slot, reorg_status, decoder_coverage FROM chain_wallet_trades ORDER BY id LIMIT 1").get();
  assert.equal(evidence.signature, evidence.raw_event_signature);
  assert.equal(evidence.slot, evidence.raw_event_slot);
  assert.equal(evidence.reorg_status, "pending_confirmation");
  assert.equal(evidence.decoder_coverage, "swap_only");
  assert.equal(db.prepare("SELECT bought_amount FROM chain_wallet_token_summary WHERE wallet=? AND token_mint=?")
    .get(WALLET, MINT_A).bought_amount, "150");

  const replay = cache.cacheWalletTrades(db, WALLET, [event], decoder, { now: 2000 });
  assert.equal(replay.upserted, 2, "idempotent upsert must preserve both distinct legs");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_wallet_trades").get().n, 2,
    "replay must not duplicate either leg");
  assert.equal(db.prepare("SELECT trades_count FROM chain_wallet_token_summary WHERE wallet=? AND token_mint=?")
    .get(WALLET, MINT_A).trades_count, 2);

  cache.markWalletHistory(db, WALLET, {
    complete: true, backfillCursor: null, forwardCursor: null, possibleGap: false, now: 3000
  });
  assert.equal(db.prepare("SELECT history_status FROM chain_wallet_discovery WHERE wallet=?").get(WALLET).history_status, "partial",
    "swap-only decoder coverage must never promote history to complete");
  assert.equal(cache.walletHistoryFresh(db, WALLET, 4000), false,
    "swap-only wallet history is not reusable as complete");
  cache.markWalletHistory(db, WALLET, {
    complete: true, decoderCoverage: "full", backfillCursor: null, forwardCursor: null,
    possibleGap: false, now: 6000, pagesFetched: 2, lastPageEmpty: true
  });
  assert.equal(cache.walletHistoryFresh(db, WALLET, 7000), true,
    "full decoder coverage plus complete history should be reusable without RPC");
  assert.equal(db.prepare("SELECT pages_fetched FROM chain_wallet_pagination_state WHERE wallet=?").get(WALLET).pages_fetched, 2);
  assert.equal(db.prepare("SELECT status, coverage_percent, decoder_coverage FROM chain_history_coverage WHERE entity_key=?").get(WALLET).status, "complete");
  cache.recordBudgetUsage(db, { provider: "helius", endpoint: "test", costUnits: 3, costKind: "http", entityKind: "wallet", entityKey: WALLET });
  assert.equal(db.prepare("SELECT cost_kind, cost_units FROM chain_budget_ledger").get().cost_kind, "http");
  assert.equal(db.prepare("SELECT cost_units FROM chain_budget_ledger").get().cost_units, 3);
  assert.equal(cache.authoritativePnlAllowed({
    historyComplete: true, decoderCoverage: "full", costBasisComplete: true,
    completeFromObservedTrades: true, orderingComplete: true, reorgStable: true,
    unknownOperationsRatio: 0.05
  }), true);
  assert.equal(cache.authoritativePnlAllowed({
    historyComplete: true, decoderCoverage: "full", costBasisComplete: true,
    completeFromObservedTrades: true, orderingComplete: true, reorgStable: true,
    unknownOperationsRatio: 0.051
  }), false, "unknown operation ratio above 5% must block authoritative PnL");
  assert.equal(cache.calculateDataConfidence({
    historyComplete: true, decoderCoverage: "swap_only", unknownOperationsRatio: 0,
    costBasisComplete: true, orderingComplete: true, reorgStable: true
  }), 0.25);
  assert.equal(cache.walletHistoryFresh(db, WALLET, 3 * 3600_000 + 7000), false,
    "an active wallet history must be refreshed after the freshness window");
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
