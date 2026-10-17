#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const cache = require("./blockchain-wallet-cache.cjs");
require("ts-node").register({ skipProject: true, transpileOnly: true, compilerOptions: { module: "commonjs" } });
const { computeWalletCostBasisLedger } = require("../lib/trade/chain/quality-v3.ts");

const WALLET = "11111111111111111111111111111111";
const MINT_A = "So11111111111111111111111111111111111111112";
const MINT_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// Exercise additive migration against the pre-coverage wallet-cache schema.
const legacyDb = new Database(":memory:");
try {
  legacyDb.exec(`
    CREATE TABLE chain_wallet_discovery (
      wallet TEXT PRIMARY KEY, chain TEXT NOT NULL DEFAULT 'solana',
      discovered_via_token TEXT, discovered_via_wallet TEXT,
      discovered_via_kind TEXT NOT NULL DEFAULT 'unknown',
      first_discovered_at INTEGER NOT NULL,
      history_status TEXT NOT NULL DEFAULT 'not_fetched',
      last_fetched_at INTEGER, backfill_cursor TEXT, forward_cursor TEXT,
      backfill_complete INTEGER NOT NULL DEFAULT 0, possible_gap INTEGER NOT NULL DEFAULT 0,
      tokens_touched INTEGER NOT NULL DEFAULT 0, last_trade_at INTEGER, last_error TEXT
    );
    CREATE TABLE chain_wallet_trades (
      id INTEGER PRIMARY KEY, wallet TEXT NOT NULL, chain TEXT NOT NULL DEFAULT 'solana',
      signature TEXT NOT NULL, leg_key TEXT NOT NULL, instruction_index INTEGER, slot INTEGER,
      block_time INTEGER, commitment_level TEXT NOT NULL DEFAULT 'confirmed',
      token_mint TEXT NOT NULL, direction TEXT NOT NULL, amount_tokens TEXT, amount_sol TEXT,
      price_usd_at_time TEXT, fee_lamports INTEGER, protocol_fee_lamports INTEGER,
      dex TEXT, pool TEXT, counterparty TEXT, decoder_version TEXT NOT NULL,
      source_provider TEXT NOT NULL DEFAULT 'helius', raw_event_kind TEXT NOT NULL DEFAULT 'wallet',
      raw_event_address TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok', UNIQUE(wallet,chain,signature,leg_key)
    );
    CREATE TABLE chain_wallet_token_summary (
      wallet TEXT NOT NULL, token_mint TEXT NOT NULL, trades_count INTEGER NOT NULL DEFAULT 0,
      first_trade_at INTEGER, last_trade_at INTEGER, bought_amount TEXT NOT NULL DEFAULT '0',
      sold_amount TEXT NOT NULL DEFAULT '0', realized_pnl TEXT, unrealized_pnl TEXT,
      status TEXT NOT NULL DEFAULT 'unknown', data_confidence REAL NOT NULL DEFAULT 0,
      PRIMARY KEY(wallet,token_mint)
    );
    CREATE TABLE chain_wallet_token_touched (
      wallet TEXT NOT NULL, token_mint TEXT NOT NULL, last_trade_at INTEGER,
      trade_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(wallet,token_mint)
    );
    INSERT INTO chain_wallet_discovery(wallet, first_discovered_at, history_status)
      VALUES('legacy-wallet', 123, 'partial');
    INSERT INTO chain_wallet_trades(wallet,signature,leg_key,token_mint,direction,decoder_version,
      raw_event_address,first_seen_at,last_seen_at)
      VALUES('legacy-wallet','legacy-signature','legacy-leg','legacy-mint','buy','old-decoder',
      'legacy-wallet',123,124);
  `);
  cache.ensureWalletCacheSchema(legacyDb);
  const migratedDiscovery = legacyDb.prepare(
    "SELECT decoder_coverage,last_decoder_version FROM chain_wallet_discovery WHERE wallet='legacy-wallet'"
  ).get();
  assert.equal(migratedDiscovery.decoder_coverage, "swap_only");
  assert.equal(migratedDiscovery.last_decoder_version, "wallet-trades-v1");
  const migratedTrade = legacyDb.prepare(
    "SELECT raw_event_signature,signature,raw_event_slot,reorg_status FROM chain_wallet_trades WHERE signature='legacy-signature'"
  ).get();
  assert.equal(migratedTrade.raw_event_signature, migratedTrade.signature,
    "migration must backfill raw evidence identity without dropping rows");
  assert.equal(migratedTrade.raw_event_slot, null);
  assert.equal(migratedTrade.reorg_status, "pending_confirmation");
  assert.equal(legacyDb.prepare("SELECT COUNT(*) AS n FROM chain_wallet_trades").get().n, 1);
} finally {
  legacyDb.close();
}

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

  const first = cache.cacheWalletTrades(db, WALLET, [event], decoder, { now: 1_800_000_000_000 });
  const rejected = cache.cacheWalletTrades(db, WALLET,
    [{ ...event, signature: "failed-swap", transactionError: { InstructionError: [0, "failed"] } }],
    () => { throw new Error("failed transaction must not reach decoder"); });
  assert.equal(rejected.upserted, 0);
  assert.deepEqual(first.tokenMints, [MINT_A, MINT_B]);
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

  const replay = cache.cacheWalletTrades(db, WALLET, [event], decoder, { now: 1_800_000_001_000 });
  assert.equal(replay.upserted, 2, "idempotent upsert must preserve both distinct legs");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_wallet_trades").get().n, 2,
    "replay must not duplicate either leg");
  assert.equal(db.prepare("SELECT trades_count FROM chain_wallet_token_summary WHERE wallet=? AND token_mint=?")
    .get(WALLET, MINT_A).trades_count, 2);

  cache.markWalletHistory(db, WALLET, {
    complete: true, backfillCursor: null, forwardCursor: null, possibleGap: false, now: 1_800_000_002_000
  });
  assert.equal(db.prepare("SELECT history_status FROM chain_wallet_discovery WHERE wallet=?").get(WALLET).history_status, "partial",
    "swap-only decoder coverage must never promote history to complete");
  assert.equal(cache.walletHistoryFresh(db, WALLET, 1_800_000_002_500), false,
    "swap-only wallet history is not reusable as complete");
  cache.markWalletHistory(db, WALLET, {
    complete: true, decoderCoverage: "full", backfillCursor: null, forwardCursor: null,
    possibleGap: false, now: 1_800_000_003_000, pagesFetched: 2, lastPageEmpty: true
  });
  assert.equal(cache.walletHistoryFresh(db, WALLET, 1_800_000_003_500), true,
    "full decoder coverage plus complete history should be reusable without RPC");
  assert.equal(db.prepare("SELECT pages_fetched FROM chain_wallet_pagination_state WHERE wallet=?").get(WALLET).pages_fetched, 2);
  assert.equal(db.prepare("SELECT status, coverage_percent, decoder_coverage FROM chain_history_coverage WHERE entity_key=?").get(WALLET).status, "complete");
  cache.recordBudgetUsage(db, { provider: "helius", endpoint: "test", costUnits: 3, costKind: "http", entityKind: "wallet", entityKey: WALLET });
  assert.equal(db.prepare("SELECT cost_kind, cost_units FROM chain_budget_ledger").get().cost_kind, "http");
  assert.equal(db.prepare("SELECT cost_units FROM chain_budget_ledger").get().cost_units, 3);
  assert.equal(cache.authoritativePnlAllowed({
    historyComplete: true, decoderCoverage: "full", costBasisComplete: true,
    completeFromObservedTrades: true, orderingComplete: true, reorgStable: true,
    sourceReconciled: true, unknownOperationsRatio: 0.05
  }), true);
  assert.equal(cache.authoritativePnlAllowed({
    historyComplete: true, decoderCoverage: "full", costBasisComplete: true,
    completeFromObservedTrades: true, orderingComplete: true, reorgStable: true,
    sourceReconciled: true, unknownOperationsRatio: 0.051
  }), false, "unknown operation ratio above 5% must block authoritative PnL");
  assert.equal(cache.calculateDataConfidence({
    historyComplete: true, decoderCoverage: "swap_only", unknownOperationsRatio: 0,
    costBasisComplete: true, orderingComplete: true, reorgStable: true
  }), 0.25);

  const rawTrades = [
    { signature: "buy-1", timestamp: 100, slot: 10, trader: WALLET, type: "buy",
      amountSol: 1, amountTokens: 100, priceSol: 0.01, quoteMint: MINT_A, quoteAmount: 1 },
    { signature: "sell-1", timestamp: 200, slot: 20, trader: WALLET, type: "sell",
      amountSol: 0.75, amountTokens: 50, priceSol: 0.015, quoteMint: MINT_A, quoteAmount: 0.75 }
  ];
  const noProvenance = computeWalletCostBasisLedger(WALLET, rawTrades, true);
  assert.equal(noProvenance.costBasisComplete, false,
    "legacy callers without decoder/finality provenance must fail closed");
  assert.equal(noProvenance.realizedPnl, null);
  const unreconciled = computeWalletCostBasisLedger(WALLET, rawTrades, true, null, {
    decoderCoverage: "full", unknownOperationsRatio: 0, reorgStable: true, sourceReconciled: false
  });
  assert.equal(unreconciled.costBasisComplete, false,
    "PnL must remain non-authoritative until token_trades matches leg-level evidence");
  assert.equal(unreconciled.realizedPnl, null);
  const verified = computeWalletCostBasisLedger(WALLET, rawTrades, true, null, {
    decoderCoverage: "full", unknownOperationsRatio: 0.05, reorgStable: true, sourceReconciled: true
  });
  assert.equal(verified.costBasisComplete, true);
  assert.equal(verified.realizedPnl, 0.25);
  const unknownTooHigh = computeWalletCostBasisLedger(WALLET, rawTrades, true, null, {
    decoderCoverage: "full", unknownOperationsRatio: 0.051, reorgStable: true, sourceReconciled: true
  });
  assert.equal(unknownTooHigh.costBasisComplete, false);
  assert.equal(unknownTooHigh.realizedPnl, null);
  const notFinalized = computeWalletCostBasisLedger(WALLET, rawTrades, true, null, {
    decoderCoverage: "full", unknownOperationsRatio: 0, reorgStable: false, sourceReconciled: true
  });
  assert.equal(notFinalized.costBasisComplete, false);
  assert.equal(notFinalized.realizedPnl, null);
  assert.equal(cache.walletHistoryFresh(db, WALLET, 1_800_000_003_000 + 3 * 3600_000), false,
    "an active wallet history must be refreshed after the freshness window");
  cache.markWalletHistory(db, WALLET, {
    complete: false, backfillCursor: "cursor-1", forwardCursor: null, possibleGap: false, now: 1_800_000_004_000
  });
  assert.equal(cache.walletHistoryFresh(db, WALLET, 1_800_000_004_500), false,
    "partial history must never be considered reusable as complete");

  const discovery = db.prepare("SELECT history_status, backfill_cursor FROM chain_wallet_discovery WHERE wallet=?").get(WALLET);
  assert.equal(discovery.history_status, "partial");
  assert.equal(discovery.backfill_cursor, "cursor-1");
  console.log("[blockchain-wallet-cache-regression] OK: idempotency, summaries, complete-history reuse, partial resume state");
} finally {
  db.close();
}
