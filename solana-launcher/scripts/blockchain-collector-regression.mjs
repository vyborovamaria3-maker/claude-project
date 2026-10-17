import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

function loadTs(path, mocks = {}, globals = {}) {
  const compiled = ts.transpileModule(read(path), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, path + " must transpile");
  const sandboxModule = { exports: {} };
  const context = vm.createContext({
    console, Date, Math, Map, Set, URL, AbortSignal, setTimeout, clearTimeout,
    process: { env: {} }, ...globals,
  });
  const code = "(function (require, module, exports) { " + compiled.outputText + "\n })";
  const wrapper = vm.runInContext(code, context, { filename: path });
  wrapper((id) => id in mocks ? mocks[id] : require(id), sandboxModule, sandboxModule.exports);
  return sandboxModule.exports;
}

const indexerSource = read("lib/trade/pump-portal-indexer.ts");
const dbSource = read("lib/trade/db.ts");
assert.match(dbSource, /PRIMARY KEY \(mint, creator\)/);
assert.match(indexerSource, /ON CONFLICT\(mint, creator\) DO UPDATE/);
assert.match(dbSource, /CREATE TABLE IF NOT EXISTS token_trade_sync/);
assert.match(dbSource, /slot = COALESCE\(excluded\.slot, token_trades\.slot\)/);

const events = [];
const timers = new Map();
let nextTimer = 0;
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances = [];
  readyState = 0;
  handlers = new Map();
  constructor() { FakeWebSocket.instances.push(this); }
  on(type, fn) { this.handlers.set(type, fn); }
  send() {}
  emit(type, ...args) { this.handlers.get(type)?.(...args); }
  close() { this.readyState = 3; this.emit("close"); }
}
const collector = loadTs("lib/marketCollector.ts", {
  ws: FakeWebSocket,
  "./trade/db": {
    persistMarketEvent: (event) => {
      if (events.some((item) => item.eventId === event.eventId)) return false;
      events.push(event);
      return true;
    },
    getMarketCollectorStatus: () => ({
      events: events.length, lastEventAt: null, launches: 0, migrations: 0, trades: 0,
    }),
  },
}, {
  setTimeout: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
  clearTimeout: (id) => timers.delete(id),
});
collector.startMarketCollector();
const ws = FakeWebSocket.instances.at(-1);
ws.emit("open");
ws.emit("message", JSON.stringify({ txType: "create", mint: "mintA", signature: "one" }));
ws.emit("message", JSON.stringify({ txType: "buy", mint: "mintA", signature: "two", solAmount: 1 }));
ws.emit("message", JSON.stringify({ txType: "buy", mint: "mintA", signature: "three", pool: "pool-id" }));
ws.emit("message", JSON.stringify({ txType: "other", mint: "mintA", signature: "four" }));
assert.deepEqual(events.map((event) => event.kind), ["launch", "trade", "migration"]);
const firstId = events[0].eventId;
ws.emit("message", JSON.stringify({ txType: "create", mint: "mintA", signature: "one" }));
assert.equal(events[0].eventId, firstId);
assert.equal(events.length, 3, "replayed event must be deduplicated");
ws.emit("close");
assert.equal(collector.getCollectorStatus().needsBackfill, true);
assert.equal(timers.size, 1, "disconnect must schedule one reconnect");
collector.stopMarketCollector();
assert.equal(timers.size, 0, "stop must cancel reconnect");

let fetchImpl = async () => ({ ok: true, json: async () => [] });
const helius = loadTs("lib/trade/helius.ts", {
  "./chain/types": { WRAPPED_SOL_MINT: "So11111111111111111111111111111111111111112" },
  "./helius-rotation": {
    appendHeliusApiKey: (url, key) => url + "?api-key=" + encodeURIComponent(key),
    getHeliusApiKeys: () => ["key-a", "key-b"],
    isHeliusRetryableStatus: (status) => [429, 500, 502, 503, 504].includes(status),
  },
}, { fetch: (...args) => fetchImpl(...args) });
let calls = [];
fetchImpl = async (url) => {
  calls.push(new URL(url));
  return {
    ok: true,
    json: async () => [
      { signature: "new", timestamp: 100 },
      { signature: "known", timestamp: 90 },
      { signature: "old", timestamp: 80 },
    ],
  };
};
const incremental = await helius.fetchEnrichedTxsForMintWithMeta("mintA", 10, new Set(["known"]));
const successfulSwap = { signature: "swap", timestamp: 100, events: { swap: {
  nativeInput: { account: "wallet", amount: "1000000000" },
  tokenOutputs: [{ userAccount: "wallet", mint: "mintA", rawTokenAmount: { tokenAmount: "100", decimals: 0 } }],
} } };
assert.equal(helius.txsToTrades([successfulSwap], "mintA").length, 1);
assert.equal(helius.txsToTrades([{ ...successfulSwap, transactionError: { InstructionError: [0, "failed"] } }], "mintA").length, 0);
assert.deepEqual(Array.from(incremental.transactions, (tx) => String(tx.signature)), ["new"]);
assert.equal(incremental.reachedKnownHistory, true);
assert.equal(incremental.truncated, false);
assert.equal(calls.length, 1);

calls = [];
fetchImpl = async (url) => {
  calls.push(new URL(url));
  if (new URL(url).searchParams.get("api-key") === "key-a") {
    return { ok: false, status: 429 };
  }
  return { ok: true, json: async () => [] };
};
assert.equal((await helius.fetchEnrichedTxsForMintWithMeta("mintA", 10)).exhausted, true);
assert.equal(calls.length, 2, "429 must rotate to next key");

calls = [];
fetchImpl = async (url) => {
  calls.push(new URL(url));
  return { ok: false, status: 503 };
};
await assert.rejects(
  helius.fetchEnrichedTxsForMintWithMeta("mintA", 10),
  (error) => {
    assert.equal(error.httpRequests, 4, "exhausted retries must expose every HTTP attempt");
    return true;
  },
);
assert.equal(calls.length, 4, "two rounds across two keys must count four failed attempts");

calls = [];
fetchImpl = async (url) => {
  calls.push(new URL(url));
  return { ok: false, status: 401 };
};
await assert.rejects(
  helius.fetchEnrichedTxsForMintWithMeta("mintA", 10),
  (error) => {
    assert.equal(error.httpRequests, 1, "non-retryable 4xx must still expose the attempted request");
    return true;
  },
);
assert.equal(calls.length, 1, "non-retryable 4xx must not rotate keys");

let checkedAt = null;
let fetchCount = 0;
let savedRows = [{
  signature: "known", timestamp: 100, trader: "wallet", type: "buy",
  amountSol: 1, amountTokens: 100, priceSol: 0.01,
}];
const newRow = {
  signature: "new", timestamp: 110, trader: "wallet", type: "buy",
  amountSol: 2, amountTokens: 200, priceSol: 0.01,
};
const cache = loadTs("lib/trade/trade-cache.ts", {
  "./merged-trades": {
    fetchMergedTradesForMint: async (_mint, _maxTrades, _onProgress, known) => {
      fetchCount++;
      assert.equal(known.has("known"), true);
      return [newRow];
    },
  },
  "./db": {
    getTokenTrades: () => savedRows,
    getTokenTradeLastCheckedAt: () => checkedAt,
    markTokenTradeChecked: () => { checkedAt = Date.now(); },
    persistTokenTrades: (_mint, rows) => { savedRows = [...savedRows, ...rows]; },
  },
});
assert.equal((await cache.loadTokenTrades("mintA")).length, 2);
assert.equal(fetchCount, 1);
assert.equal((await cache.loadTokenTrades("mintA")).length, 2);
assert.equal(fetchCount, 1, "fresh cache should avoid repeated fetch");

// Alchemy primary-provider contract: mocked JSON-RPC only; no real API requests.
// Inventory decoder and reconciliation regressions are offline-only as well.
const { createAlchemyProvider, getAlchemyConfig, normalizeFullTransaction } = require("./blockchain-alchemy-provider.cjs");
const ownerlessBalances = normalizeFullTransaction({
  signature: "ownerless-balances",
  slot: 901,
  blockTime: 1700000001,
  transaction: { signatures: ["ownerless-balances"], message: { accountKeys: [], instructions: [] } },
  meta: {
    err: null, fee: 5000, preBalances: [], postBalances: [],
    preTokenBalances: [
      { accountIndex: 2, mint: "mintA", uiTokenAmount: { amount: "100", decimals: 2 } },
      { accountIndex: 3, mint: "mintA", uiTokenAmount: { amount: "200", decimals: 2 } },
    ],
    postTokenBalances: [
      { accountIndex: 2, mint: "mintA", uiTokenAmount: { amount: "100", decimals: 2 } },
    ],
    innerInstructions: [],
  },
});
assert.equal(ownerlessBalances.tokenBalanceDeltas.length, 2,
  "ownerless token accounts must not be merged into a fabricated wallet delta");
assert.deepEqual(ownerlessBalances.tokenBalanceDeltas.map((d) => d.accountIndex), [2, 3]);
assert.ok(ownerlessBalances.tokenBalanceDeltas.every((d) => !d.ownerKnown));
const missingMeta = normalizeFullTransaction({
  signature: "missing-meta", slot: 902, blockTime: 1700000002,
  transaction: { signatures: ["missing-meta"], message: { accountKeys: [], instructions: [] } },
  meta: null,
});
assert.notEqual(missingMeta.transactionError, null,
  "missing execution metadata must be unknown, not silently successful");
const { decodeInventoryMovements } = require("./blockchain-inventory-decoder.cjs");
const inventoryEvidence = decodeInventoryMovements({
  signature: "inventory-evidence", slot: 903, timestamp: 1700000003,
  decodedOperations: [
    { type: "transferChecked", info: { source: "tokenAccountA", destination: "tokenAccountB",
      mint: "mintA", tokenAmount: { amount: "1250", decimals: 2 }, authority: "authorityA" } },
    { type: "mintTo", info: { account: "tokenAccountB", mint: "mintA", amount: "100" } },
    { type: "burn", info: { account: "tokenAccountA", mint: "mintA", amount: "50" } },
  ],
  tokenBalanceDeltas: [
    { owner: "walletA", tokenAccount: "tokenAccountA", mint: "mintA", deltaRaw: "-1250" },
    { owner: "walletB", tokenAccount: "tokenAccountB", mint: "mintA", deltaRaw: "1250" },
  ],
});
assert.equal(inventoryEvidence.length, 4, "transfer must produce two evidence legs plus mint and burn");
assert.deepEqual(inventoryEvidence.slice(0, 2).map((m) => [m.owner, m.direction]),
  [["walletA", "out"], ["walletB", "in"]]);
assert.equal(inventoryEvidence[0].amountRaw, "1250");
assert.equal(inventoryEvidence[0].decimals, 2);
assert.equal(inventoryEvidence[2].kind, "mint");
assert.equal(inventoryEvidence[2].owner, "walletB");
assert.equal(inventoryEvidence[3].kind, "burn");
assert.equal(inventoryEvidence[3].owner, "walletA");
const unknownInventory = decodeInventoryMovements({
  signature: "unknown-inventory",
  decodedOperations: [{ type: "transfer", info: { source: "unknownA", destination: "unknownB", amount: "7" } }],
  tokenBalanceDeltas: [],
});
assert.equal(unknownInventory.length, 2);
assert.ok(unknownInventory.every((m) => m.owner === null && m.attributionStatus === "owner_unknown"),
  "unknown transfer ownership must be preserved as unknown, not guessed");
const { reconcileTradeEvidence } = require("./blockchain-trade-reconciliation.cjs");
const reconciliation = reconcileTradeEvidence({
  mint: "mintA",
  events: [{
    signature: "trade-1", slot: 10, transactionError: null,
    tokenBalanceDeltas: [{ owner: "walletA", mint: "mintA", deltaRaw: "100" }],
  }],
  trades: [{ signature: "trade-1", slot: 10, trader: "walletA", type: "buy" }],
});
assert.equal(reconciliation.status, "observed_matches_no_detected_mismatch");
assert.equal(reconciliation.authority, "diagnostic_only");
assert.equal(reconciliation.historyComplete, false);
const brokenReconciliation = reconcileTradeEvidence({
  mint: "mintA",
  events: [{
    signature: "trade-2", slot: 10, transactionError: null,
    tokenBalanceDeltas: [{ owner: "walletA", mint: "mintA", deltaRaw: "-100" }],
  }],
  trades: [
    { signature: "missing-trade", slot: 11, trader: "walletA", type: "buy" },
    { signature: "trade-2", slot: 11, trader: "walletB", type: "buy" },
  ],
});
assert.equal(brokenReconciliation.status, "needs_review");
assert.equal(brokenReconciliation.tradesWithoutEvent.length, 1);
assert.equal(brokenReconciliation.slotMismatches.length, 1);
assert.equal(brokenReconciliation.ownerMismatches.length, 1);
assert.equal(brokenReconciliation.directionMismatches.length, 1);
assert.equal(brokenReconciliation.authority, "diagnostic_only");
assert.throws(() => getAlchemyConfig({}), /Alchemy Solana API key|ALCHEMY_SOLANA_RPC_URL/);
assert.equal(getAlchemyConfig({
  NEXT_PUBLIC_QUICKNODE_RPC_URL: "https://solana-mainnet.g.alchemy.com/v2/legacy-test-key",
}).endpoint, "https://solana-mainnet.g.alchemy.com/v2/legacy-test-key",
"legacy variable name is accepted only when the URL host is Alchemy");
assert.throws(() => getAlchemyConfig({
  NEXT_PUBLIC_QUICKNODE_RPC_URL: "https://example.quicknode.com/abc",
}), /Alchemy Solana API key|ALCHEMY_SOLANA_RPC_URL/,
"non-Alchemy QuickNode endpoints must not silently become the primary provider");
const alchemyCalls = [];
const alchemyPages = [
  {
    transactions: [{
      signature: "alchemy-sig-1", slot: 900, blockTime: 1700000000,
      transaction: {
        signatures: ["alchemy-sig-1"],
        message: { accountKeys: ["walletA"], instructions: [
          { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", program: "spl-token",
            parsed: { type: "transferChecked", info: { mint: "mintA", amount: "1" } } },
          { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", program: "spl-token",
            parsed: { type: "mintTo", info: { mint: "mintA", amount: "2" } } },
          { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", program: "spl-token",
            parsed: { type: "burn", info: { mint: "mintA", amount: "1" } } },
        ] },
      },
      meta: {
        err: null, fee: 5000, preBalances: [2000000000], postBalances: [1500000000],
        preTokenBalances: [],
        postTokenBalances: [{
          owner: "walletA", mint: "mintA",
          uiTokenAmount: { amount: "1000000000", decimals: 6 },
        }],
        innerInstructions: [],
      },
    }],
    paginationToken: "cursor-2",
  },
  { transactions: [], paginationToken: null },
];
const alchemy = createAlchemyProvider({
  endpoint: "https://solana-mainnet.g.alchemy.com/v2/test-key",
  sleep: async () => {},
  fetch: async (_url, options) => {
    const request = JSON.parse(options.body);
    alchemyCalls.push(request);
    const result = alchemyPages.shift();
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: request.id, result }) };
  },
});
const alchemyPage1 = await alchemy.fetchTransactionsForAddress("walletA", 1);
assert.equal(alchemyPage1.source, "alchemy");
assert.equal(alchemyPage1.transactions[0].signature, "alchemy-sig-1");
assert.equal(alchemyPage1.transactions[0].slot, 900);
assert.equal(alchemyPage1.transactions[0].tokenBalanceDeltas[0].delta, 1000);
assert.deepEqual(alchemyPage1.transactions[0].decodedOperations.map((op) => op.type),
  ["transferChecked", "mintTo", "burn"]);
assert.ok(alchemyPage1.transactions[0].decodedOperations.every((op) =>
  op.decoderCoverage === "swap_and_transfers_mint_burn"));
assert.equal(alchemyPage1.nextCursor, "alchemy:v1:cursor-2");
assert.equal(alchemyPage1.exhausted, false);
const alchemyPage2 = await alchemy.fetchTransactionsForAddress("walletA", 1, new Set(), alchemyPage1.nextCursor);
assert.equal(alchemyPage2.exhausted, true);
assert.equal(alchemyCalls.length, 2);
assert.equal(alchemyCalls[0].method, "getTransactionsForAddress");
assert.equal(alchemyCalls[0].params[1].transactionDetails, "full");
assert.equal(alchemyCalls[0].params[1].commitment, "finalized");
assert.equal(alchemyCalls[1].params[1].paginationToken, "cursor-2");
assert.equal(alchemyCalls[1].params[1].encoding, "jsonParsed");

let alchemyRetryCalls = 0;
const alchemyRetry = createAlchemyProvider({
  endpoint: "https://solana-mainnet.g.alchemy.com/v2/test-key",
  sleep: async () => {},
  fetch: async (_url, options) => {
    alchemyRetryCalls++;
    const request = JSON.parse(options.body);
    if (alchemyRetryCalls === 1) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({
      jsonrpc: "2.0", id: request.id, result: { transactions: [], paginationToken: null },
    }) };
  },
});
const retried = await alchemyRetry.fetchTransactionsForAddress("walletA", 1);
assert.equal(retried.httpRequests, 2, "Alchemy ledger must count retries");
assert.equal(alchemyRetryCalls, 2);
const { createAlchemyProvider: noFallbackProvider } = require("./blockchain-alchemy-provider.cjs");
assert.throws(() => noFallbackProvider({ env: {}, fetch: async () => { throw new Error("must not call network"); } }),
  /Alchemy Solana API key|ALCHEMY_SOLANA_RPC_URL/,
  "missing Alchemy configuration must fail closed, never fall back to Helius");

console.log("[blockchain-collector-regression] OK: SQLite contract, PumpPortal, reconnect, legacy Helius helper, Alchemy pagination/retry and incremental cache");
