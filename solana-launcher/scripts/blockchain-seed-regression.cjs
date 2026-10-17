#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const core = require("./blockchain-seed-core.cjs");

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
assert(core.isSolanaAddress(SOL));
assert(core.isSolanaAddress(USDC));
assert(core.isSolanaAddress(PUMP));
assert(core.isSolanaAddress("11111111111111111111111111111111"));
assert(!core.isSolanaAddress("1111111111111111111111111111111"));
assert(!core.isSolanaAddress("not_an_address"));
assert(!core.isSolanaAddress(SOL + "a"));
assert.equal(core.extractAddress("https://solscan.io/token/" + SOL), SOL);
assert.equal(core.extractAddress("https://dexscreener.com/solana/" + PUMP), null);

const workbook = {
  SheetNames: ["Trending", "Other"],
  Sheets: {
    Trending: {
      A1: { v: "Pair Address" }, B1: { v: "Token Address" },
      C1: { v: "Volume" },
      A2: { v: PUMP }, B2: { v: SOL }, C2: { v: 1000 },
      A3: { v: "pair" }, B3: { v: USDC },
      A4: { v: "pair" }, B4: { v: "garbage" },
    },
    Other: {
      A1: { v: "MINT" },
      A2: { v: SOL }, A3: { v: PUMP },
    },
  },
};
const parsed = core.parseWorkbook(workbook, "dex_trending");
assert.equal(parsed.kind, "token");
assert.deepEqual(parsed.addresses.sort(), [SOL, USDC, PUMP].sort());
assert.equal(parsed.sheets[0].skipped, 1);
assert.equal(parsed.sheets[0].headerFound, true);

const noHeader = core.parseSheet({
  A1: { v: "Pair Address" }, B1: { v: "volume" },
  A2: { v: PUMP }, B2: { v: 1000 },
}, "token");
assert.equal(noHeader.addresses.length, 0,
  "a multi-column pair address is not a mint");

const profitable = core.parseWorkbook({
  SheetNames: ["Wallets"],
  Sheets: {
    Wallets: {
      A1: { v: "Кошелёк" }, B1: { v: "PnL" },
      A2: { v: PUMP }, B2: { v: 5000 },
      A3: { v: PUMP }, B3: { v: 6000 },
      A4: { v: USDC }, B4: { v: -20 },
    },
  },
}, "profitable_wallets");
assert.equal(profitable.kind, "wallet");
assert.equal(profitable.addresses.length, 2);
assert(core.PRIORITIES.dex_trending > core.PRIORITIES.migrated);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chain-seeds-"));
try {
  fs.mkdirSync(path.join(tmp, "nested"));
  fs.writeFileSync(path.join(tmp, "a.xlsx"), "placeholder");
  fs.writeFileSync(path.join(tmp, "~$lock.xlsx"), "placeholder");
  fs.writeFileSync(path.join(tmp, "nested", "b.XLSX"), "placeholder");
  assert.equal(core.scanFolder(tmp).length, 2);
  assert.throws(() => core.scanFolder(tmp, 1), /Too many XLSX/);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
execFileSync(process.execPath, ["--check",
  path.join(__dirname, "blockchain-seed-collector.cjs")], { stdio: "pipe" });
console.log("[blockchain-seed-regression] OK: valid Solana keys, XLSX categories, dedup, pair safety, nested folders, collector syntax");
