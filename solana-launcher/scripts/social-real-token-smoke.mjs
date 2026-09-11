import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function arg(name, fallback = "") {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

const mint = arg("mint", "5zFdUjQk5bX55Ej27Gk552535NNwAq95fAfMwrzrpump");
const frontend = arg("frontend", process.env.SOCIAL_FRONTEND_URL || "http://localhost:3003").replace(/\/$/, "");
const intelligence = arg("intelligence", process.env.MEMECOIN_INTELLIGENCE_URL || "http://localhost:3001").replace(/\/$/, "");
const strictSocial = args.includes("--strict-social");
const timeoutMs = Number(arg("timeout", "45000")) || 45_000;

const TF_SECONDS = {
  "1s": 1,
  "5s": 5,
  "15s": 15,
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};
const SECOND_TFS = new Set(["1s", "5s", "15s"]);
const REQUIRED_REAL_TFS = new Set(["1m"]);

let failures = 0;
let warnings = 0;
const results = [];

function record(state, label, detail = "") {
  const prefix = state === "PASS" ? "PASS" : state === "WARN" ? "WARN" : "FAIL";
  console.log(`${prefix.padEnd(4)} ${label}${detail ? ` — ${detail}` : ""}`);
  results.push({ state, label, detail });
  if (state === "FAIL") failures += 1;
  if (state === "WARN") warnings += 1;
}

function finitePositive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { response, data, text };
}

function validateCandles(candles, tf) {
  if (!Array.isArray(candles)) return "candles is not an array";
  const step = TF_SECONDS[tf];
  let previous = null;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index] || {};
    const time = Number(candle.time);
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const volume = Number(candle.volume);
    if (![time, open, high, low, close, volume].every(Number.isFinite)) return `non-finite candle at ${index}`;
    if (time <= 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) return `invalid OHLCV at ${index}`;
    if (high + Number.EPSILON < Math.max(open, close)) return `high below body at ${index}`;
    if (low - Number.EPSILON > Math.min(open, close)) return `low above body at ${index}`;
    if (previous != null && time <= previous) return `timestamps are not strictly increasing at ${index}`;
    if (step && time % step !== 0) return `timestamp ${time} is not aligned to ${tf}`;
    previous = time;
  }
  return null;
}

async function testValidationGuards() {
  try {
    const invalidMint = await request(`${frontend}/api/token-history?mint=not-a-solana-mint&tf=1m`);
    record(invalidMint.response.status === 400 ? "PASS" : "FAIL", "token-history rejects invalid mint", `HTTP ${invalidMint.response.status}`);
  } catch (error) {
    record("FAIL", "token-history invalid-mint guard", error instanceof Error ? error.message : String(error));
  }

  try {
    const invalidTf = await request(`${frontend}/api/token-history?mint=${encodeURIComponent(mint)}&tf=2s`);
    record(invalidTf.response.status === 400 ? "PASS" : "FAIL", "token-history rejects unsupported timeframe", `HTTP ${invalidTf.response.status}`);
  } catch (error) {
    record("FAIL", "token-history timeframe guard", error instanceof Error ? error.message : String(error));
  }
}

async function testExplicitMock() {
  for (const tf of ["1s", "5s", "15s"]) {
    try {
      const { response, data } = await request(`${frontend}/api/token-history?mint=${encodeURIComponent(mint)}&tf=${tf}&mock=true`);
      if (!response.ok || !data?.mock || data?.source !== "mock" || data?.priceUnit !== "token_usd") {
        record("FAIL", `explicit mock ${tf}`, `HTTP ${response.status}, source=${data?.source || "?"}, mock=${String(data?.mock)}`);
        continue;
      }
      const candles = Array.isArray(data.candles) ? data.candles : [];
      if (candles.length < 3) {
        record("FAIL", `explicit mock ${tf}`, `only ${candles.length} candles`);
        continue;
      }
      const expected = TF_SECONDS[tf];
      const diffs = candles.slice(1).map((candle, index) => Number(candle.time) - Number(candles[index].time));
      const exactSpacing = diffs.every((diff) => diff === expected);
      const candleError = validateCandles(candles, tf);
      record(exactSpacing && !candleError ? "PASS" : "FAIL", `explicit mock ${tf} spacing`, candleError || `step=${expected}s, candles=${candles.length}`);
    } catch (error) {
      record("FAIL", `explicit mock ${tf}`, error instanceof Error ? error.message : String(error));
    }
  }
}

async function testRealHistory() {
  for (const tf of Object.keys(TF_SECONDS)) {
    try {
      const { response, data } = await request(`${frontend}/api/token-history?mint=${encodeURIComponent(mint)}&tf=${tf}`);
      if (!response.ok) {
        record(REQUIRED_REAL_TFS.has(tf) ? "FAIL" : "WARN", `real candles ${tf}`, `HTTP ${response.status}: ${data?.error || "request failed"}`);
        continue;
      }
      if (data?.mock === true || data?.source === "mock") {
        record("FAIL", `real candles ${tf}`, "silent mock returned without ?mock=true");
        continue;
      }
      if (data?.priceUnit !== "token_usd") {
        record("FAIL", `real candles ${tf}`, `unexpected priceUnit=${String(data?.priceUnit)}`);
        continue;
      }
      const candles = Array.isArray(data?.candles) ? data.candles : [];
      if (candles.length === 0) {
        const state = REQUIRED_REAL_TFS.has(tf) ? "FAIL" : "WARN";
        record(state, `real candles ${tf}`, `no real rows; source=${data?.source || "none"}`);
        continue;
      }
      const candleError = validateCandles(candles, tf);
      record(candleError ? "FAIL" : "PASS", `real candles ${tf}`, candleError || `source=${data.source}, candles=${candles.length}`);
    } catch (error) {
      record(REQUIRED_REAL_TFS.has(tf) ? "FAIL" : "WARN", `real candles ${tf}`, error instanceof Error ? error.message : String(error));
    }
  }
}

async function testMarketSnapshot() {
  try {
    const { response, data } = await request(`${frontend}/api/token-ohlcv?mint=${encodeURIComponent(mint)}`);
    if (!response.ok || !data?.pair) {
      record("FAIL", "market snapshot", `HTTP ${response.status}: ${data?.error || "pair missing"}`);
      return;
    }
    const price = Number(data.pair.priceUsd);
    const cap = Number(data.pair.marketCap ?? data.pair.fdv);
    const source = data?.meta?.source || "unknown";
    if (!finitePositive(price) && !finitePositive(cap)) {
      record("FAIL", "market snapshot", `source=${source}, no positive price/cap`);
      return;
    }
    if (finitePositive(price) && finitePositive(cap)) {
      const supply = cap / price;
      const pumpSupplyPlausible = !mint.toLowerCase().endsWith("pump") || (supply >= 500_000_000 && supply <= 1_500_000_000);
      record(pumpSupplyPlausible ? "PASS" : "WARN", "market snapshot / implied supply", `source=${source}, price=${price}, cap=${cap}, impliedSupply=${Math.round(supply).toLocaleString("en-US")}`);
    } else {
      record("PASS", "market snapshot", `source=${source}, partial price/cap coverage`);
    }
  } catch (error) {
    record("FAIL", "market snapshot", error instanceof Error ? error.message : String(error));
  }
}

async function testLiveTrades() {
  try {
    const { response, data } = await request(`${frontend}/api/token-trades?mint=${encodeURIComponent(mint)}&limit=25`);
    if (response.status === 502 || response.status === 503) {
      record("WARN", "live trades", `honest upstream outage: HTTP ${response.status}`);
      return;
    }
    if (!response.ok || !Array.isArray(data)) {
      record("FAIL", "live trades", `HTTP ${response.status}, payload is not an array`);
      return;
    }
    const invalid = data.find((row) => !row?.signature || !Number.isFinite(Number(row?.timestamp)) || Number(row.timestamp) <= 0);
    if (invalid) {
      record("FAIL", "live trades", "contains row without signature/valid timestamp");
      return;
    }
    record("PASS", "live trades", `${data.length} rows; zero rows are allowed, upstream status is explicit`);
  } catch (error) {
    record("WARN", "live trades", error instanceof Error ? error.message : String(error));
  }
}

async function testXCollector() {
  try {
    const url = `${frontend}/api/trade/dev-twitter?mint=${encodeURIComponent(mint)}&strategy=auto&scope=mentions&limit=10&excludeSuspicious=true&verifiedOnly=false`;
    const { response, data } = await request(url);
    if (response.status === 401 || response.status === 403) {
      record(strictSocial ? "FAIL" : "WARN", "X collector", `app auth required: HTTP ${response.status}`);
      return;
    }
    if (!response.ok) {
      record(strictSocial ? "FAIL" : "WARN", "X collector", `HTTP ${response.status}: ${data?.error || data?.detail || "unavailable"}`);
      return;
    }
    const coverage = data?.meta?.coverageConfirmed;
    const tweets = Number(data?.riskUniverse?.totalTweets ?? data?.totalTweets ?? 0);
    record(coverage === false ? "WARN" : "PASS", "X collector", `strategy=${data?.collectionStrategy || "?"}, riskUniverse=${tweets}, browserAuth=${String(data?.meta?.authenticatedBrowser)}, coverage=${String(coverage)}`);
  } catch (error) {
    record(strictSocial ? "FAIL" : "WARN", "X collector", error instanceof Error ? error.message : String(error));
  }
}

async function testChainStream() {
  try {
    const { response, text } = await request(`${frontend}/api/trade/analyze-stream?mint=${encodeURIComponent(mint)}&refresh=1`);
    if (response.status === 401 || response.status === 403) {
      record(strictSocial ? "FAIL" : "WARN", "chain analysis stream", `app auth required: HTTP ${response.status}`);
      return;
    }
    if (!response.ok) {
      record("FAIL", "chain analysis stream", `HTTP ${response.status}`);
      return;
    }
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    let finalPayload = null;
    let streamError = null;
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === "final") finalPayload = event;
        if (event.type === "error") streamError = event.message || "stream error";
      } catch {
        streamError = "invalid NDJSON line";
      }
    }
    if (streamError) {
      record("FAIL", "chain analysis stream", streamError);
      return;
    }
    if (!finalPayload) {
      record("FAIL", "chain analysis stream", "stream ended without final payload");
      return;
    }
    const fakeUsd = Array.isArray(finalPayload.trades) && finalPayload.trades.some((trade) => trade?.u != null);
    const contractOk = finalPayload.schemaVersion === 3
      && finalPayload.summary?.maxTradesRequested === 5000
      && finalPayload.summary?.totalVolumeUsd == null
      && !fakeUsd;
    record(contractOk ? "PASS" : "FAIL", "chain analysis stream contract", `schema=${finalPayload.schemaVersion}, trades=${finalPayload.summary?.totalTrades ?? "?"}, max=${finalPayload.summary?.maxTradesRequested ?? "?"}, fakeUsd=${fakeUsd}`);
  } catch (error) {
    record("FAIL", "chain analysis stream", error instanceof Error ? error.message : String(error));
  }
}

async function testQwenStatus() {
  try {
    const headers = {};
    const key = process.env.MEMECOIN_INTELLIGENCE_API_KEY || "";
    if (key) headers["x-api-key"] = key;
    const { response, data } = await request(`${intelligence}/api/telegram-ai/status`, { headers });
    if (response.status === 401 || response.status === 403) {
      record(strictSocial ? "FAIL" : "WARN", "Qwen status", `intelligence API key required: HTTP ${response.status}`);
      return;
    }
    if (!response.ok) {
      record(strictSocial ? "FAIL" : "WARN", "Qwen status", `HTTP ${response.status}`);
      return;
    }
    const inference = data?.inference || {};
    const real = data?.enabled === true
      && inference.mode === "openai-compatible"
      && inference.reachable === true;
    record(real ? "PASS" : "WARN", "Qwen status", `enabled=${String(data?.enabled)}, mode=${inference.mode || "?"}, reachable=${String(inference.reachable)}, model=${inference.model || "?"}`);
  } catch (error) {
    record(strictSocial ? "FAIL" : "WARN", "Qwen status", error instanceof Error ? error.message : String(error));
  }
}

async function testLocalXSession() {
  const authPath = path.join(process.cwd(), "data", "x-auth", "storage-state.json");
  record(fs.existsSync(authPath) ? "PASS" : "WARN", "local X browser session", fs.existsSync(authPath) ? authPath : "run npm run x:login for authenticated X coverage");
}

console.log("POTAPoff real-token Social smoke");
console.log(`mint=${mint}`);
console.log(`frontend=${frontend}`);
console.log(`intelligence=${intelligence}`);
console.log(`strictSocial=${strictSocial}`);
console.log("");

await testValidationGuards();
await testExplicitMock();
await testRealHistory();
await testMarketSnapshot();
await testLiveTrades();
await testLocalXSession();
await testXCollector();
await testChainStream();
await testQwenStatus();

console.log("");
console.log(`SUMMARY pass=${results.filter((item) => item.state === "PASS").length} warn=${warnings} fail=${failures}`);
if (failures > 0) process.exitCode = 1;
