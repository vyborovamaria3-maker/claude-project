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

console.log("[blockchain-collector-regression] OK: SQLite contract, PumpPortal, reconnect, Helius and incremental cache");
