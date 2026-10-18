#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { gzipSync } = require("node:zlib");
const { execFileSync, spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { initDb } = require("./blockchain-seed-collector.cjs");
const { buildReport, integer, parseArgs } = require("./blockchain-seed-analytics.cjs");
const TOKEN = "So11111111111111111111111111111111111111112";
const WALLET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER = "11111111111111111111111111111111";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seed-analytics-"));
const filename = path.join(tmp, "fixture.db");
const script = path.join(__dirname, "blockchain-seed-analytics.cjs");
let db = new Database(filename);
try {
  initDb(db);
  db.prepare("INSERT INTO chain_seed_targets(kind,address,source_mask,last_success_at,backfill_complete) VALUES ('token',?,3,1000,1)").run(TOKEN);
  db.prepare("INSERT INTO chain_seed_targets(kind,address,source_mask,possible_gap,forward_cursor,last_error) VALUES ('wallet',?,4,1,'cursor','secret-provider-error')").run(WALLET);
  db.prepare("INSERT INTO chain_seed_targets(kind,address,source_mask) VALUES ('wallet',?,0)").run(OTHER);
  const insert = db.prepare("INSERT OR IGNORE INTO chain_seed_events(kind,address,signature,block_time,payload_gzip,payload_bytes,observed_at) VALUES (?,?,?,?,?,?,1)");
  function event(kind, address, tx, time = 100) {
    const raw = Buffer.from(JSON.stringify(tx));
    return insert.run(kind, address, tx.signature, time, gzipSync(raw), raw.length).changes;
  }
  const swap = { signature: "swap", feePayer: WALLET, fee: 5000, events: { swap: {
    nativeInput: { account: WALLET, amount: "1000000000" },
    tokenOutputs: [{ userAccount: WALLET, mint: TOKEN, rawTokenAmount: { tokenAmount: "9007199254740993123", decimals: 9 } }] } },
    tokenTransfers: [{ fromUserAccount: OTHER, toUserAccount: WALLET, mint: TOKEN, tokenAmount: 1 }],
    nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: OTHER, amount: 1000000000 }] };
  event("wallet", WALLET, swap);
  assert.equal(event("wallet", WALLET, swap), 0, "DB replay dedup");
  event("token", TOKEN, swap);
  event("wallet", WALLET, { ...swap, signature: "failed", transactionError: { error: "failure" } });
  event("wallet", WALLET, { signature: "incoming", nativeTransfers: [{ fromUserAccount: OTHER, toUserAccount: WALLET, amount: "2000000000" }] }, 110);
  event("wallet", WALLET, { signature: "self", nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: WALLET, amount: 100 }] }, 120);
  event("wallet", WALLET, { signature: "undated" }, null);
  event("wallet", WALLET, { signature: "bad-amount", nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: OTHER, amount: Number.MAX_SAFE_INTEGER + 1 }] }, 130);
  event("wallet", WALLET, { signature: "other-owner", events: { swap: {
    nativeInput: { account: OTHER, amount: "123" }, tokenOutputs: [{ mint: TOKEN, userAccount: OTHER, rawTokenAmount: { tokenAmount: "999", decimals: 9 } }] } } }, 140);
  event("wallet", WALLET, { signature: "malformed", nativeTransfers: {} }, 150);
  insert.run("wallet", WALLET, "corrupt", 160, Buffer.from("bad gzip"), 10);
  const report = buildReport(db, { now: 10000 });
  assert.equal(report.pagination.totalTargets, 2);
  assert.equal(report.categoryCoverage.find(c => c.category === "migrated").targets, 1);
  assert.equal(report.categoryCoverage.find(c => c.category === "dex_trending").targets, 1);
  const wallet = report.targets.find(t => t.kind === "wallet");
  assert.equal(wallet.metrics.swapTransactions, 1);
  assert.equal(wallet.metrics.simpleNativeBuys, 1);
  assert.equal(wallet.metrics.buyQuoteLamports, "1000000000");
  assert.equal(wallet.metrics.failedTransactions, 1);
  assert.equal(wallet.metrics.corruptEvents, 2);
  assert.equal(wallet.metrics.invalidAmounts, 1);
  assert.equal(wallet.metrics.nativeInLamports, "2000000100");
  assert.equal(wallet.metrics.nativeOutLamports, "1000000100");
  assert.equal(wallet.metrics.feePaidLamports, "10000");
  assert.equal(wallet.metrics.tokenFlows[0].inRaw, "9007199254740993123");
  assert.equal(wallet.metrics.tokenFlows[0].outRaw, "0");
  assert.equal(wallet.metrics.firstObservedBlockTime, 100);
  assert.equal(wallet.metrics.lastObservedBlockTime, 140);
  assert.equal(wallet.metrics.uniqueCounterparties, 1);
  assert.deepEqual(wallet.conclusions, { migrationVerified: null, realizedPnl: null, roi: null, profitable: null });
  assert(wallet.coverage.reasons.includes("catchup_gap"));
  assert(wallet.coverage.reasons.includes("collector_error"));
  assert(wallet.coverage.reasons.includes("never_collected"));
  assert(!JSON.stringify(report).includes("secret-provider-error"));
  const token = report.targets.find(t => t.kind === "token");
  assert.deepEqual(token.sourceCategories.sort(), ["dex_trending", "migrated"]);
  assert.equal(token.coverage.chainComplete, false);
  assert.equal(token.coverage.providerBackfillExhausted, true);
  assert.equal(token.metrics.simpleNativeBuys, 1);
  assert.equal(token.metrics.buyQuoteLamports, "1000000000");
  const window = buildReport(db, { kind: "wallet", since: 110, until: 130, now: 10000 }).targets[0];
  assert.equal(window.coverage.windowEvents, 2);
  assert.equal(window.metrics.nativeInLamports, "2000000100");
  assert(window.coverage.reasons.includes("undated_events_excluded"));
  const limited = buildReport(db, { kind: "wallet", maxEvents: 2 }).targets[0];
  assert.equal(limited.coverage.omittedEvents, 7);
  assert(limited.coverage.reasons.includes("report_event_limit"));
  assert.equal(buildReport(db, { includeInactive: true }).pagination.totalTargets, 3);
  const page = buildReport(db, { limit: 1 });
  assert.equal(page.pagination.nextOffset, 1);
  assert.equal(buildReport(db, { limit: 1, offset: 1 }).pagination.nextOffset, null);
  assert.equal(buildReport(db, { address: TOKEN }).targets.length, 1);
  const budget = buildReport(db, { maxBytes: 1 });
  assert(budget.targets[0].coverage.reasons.includes("report_payload_budget"));
  assert.equal(budget.targets[0].coverage.scannedEvents, 0);
  assert.equal(budget.payloadBudget.consumedBytes, 0);
  assert(buildReport(db, { now: 100000000 }).targets[0].coverage.reasons.includes("stale"));
  assert.throws(() => buildReport(db, { since: 100, until: 100 }), /precede/);
  assert.throws(() => buildReport(db, { kind: "wallet' OR 1=1" }), /kind/);
  assert.throws(() => buildReport(db, { address: "invalid" }), /address/);
  assert.throws(() => buildReport(db, { limit: 500, maxEvents: 100000 }), /budget/);
  assert.throws(() => parseArgs(["--typo", "x"]), /flag/);
  assert.equal(integer(-1), null);
  assert.equal(integer(1.5), null);
  assert.equal(integer("9007199254740993123"), 9007199254740993123n);
  const routed = structuredClone(swap);
  routed.signature = "routed";
  routed.events.swap.tokenOutputs.push({ ...routed.events.swap.tokenOutputs[0], mint: OTHER });
  event("token", TOKEN, routed);
  const sell = { signature: "sell", events: { swap: {
    nativeOutput: { account: WALLET, amount: "3000000000" },
    tokenInputs: swap.events.swap.tokenOutputs } } };
  event("token", TOKEN, sell);
  const quoted = buildReport(db, { kind: "token" }).targets[0].metrics;
  assert.equal(quoted.swapTransactions, 3);
  assert.equal(quoted.simpleNativeBuys, 1, "multi-asset route cannot inherit the full native quote");
  assert.equal(quoted.simpleNativeSells, 1);
  assert.equal(quoted.buyQuoteLamports, "1000000000");
  assert.equal(quoted.sellQuoteLamports, "3000000000");
  // Gzip bomb cannot exceed the collector's 512 KiB uncompressed evidence cap.
  insert.run("wallet", WALLET, "bomb", 170, gzipSync(Buffer.alloc(600000)), 100);
  assert.equal(buildReport(db, { kind: "wallet" }).targets[0].metrics.corruptEvents, 3);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  db = null;
  const before = fs.readFileSync(filename);
  const cli = JSON.parse(execFileSync(process.execPath, [script, "--db", filename, "--kind", "token"], { encoding: "utf8" }));
  assert.equal(cli.targets.length, 1);
  assert.deepEqual(fs.readFileSync(filename), before, "CLI must not alter existing DB");
  const missing = path.join(tmp, "missing.db");
  assert.notEqual(spawnSync(process.execPath, [script, "--db", missing]).status, 0);
  assert(!fs.existsSync(missing), "missing DB must not be created");
  const empty = path.join(tmp, "empty.db");
  new Database(empty).close();
  assert.notEqual(spawnSync(process.execPath, [script, "--db", empty]).status, 0, "missing schema must fail explicitly");
  const readOnly = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    readOnly.pragma("query_only = ON");
    assert.equal(buildReport(readOnly).targets.length, 2);
    assert.throws(() => readOnly.prepare("DELETE FROM chain_seed_events").run(), /readonly/);
  } finally { readOnly.close(); }
  console.log("[blockchain-seed-analytics] OK: real SQLite, read-only CLI, labels, exact units, failed/ambiguous data, gzip bounds, coverage, filters and pagination");
} finally {
  if (db) db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
