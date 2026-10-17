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
const { createAlchemyProvider, getAlchemyConfig } = require("./blockchain-alchemy-provider.cjs");
assert.throws(() => getAlchemyConfig({}), /Alchemy Solana API key|ALCHEMY_SOLANA_RPC_URL/);
const alchemyCalls = [];
const alchemyPages = [
  {
    transactions: [{
      signature: "alchemy-sig-1", slot: 900, blockTime: 1700000000,
      transaction: {
        signatures: ["alchemy-sig-1"],
        message: { accountKeys: ["walletA"], instructions: [] },
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
assert.equal(alchemyPage1.transactions[0].decodedOperations.length, 0);
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
