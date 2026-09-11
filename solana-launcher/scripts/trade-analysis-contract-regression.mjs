import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const analyze = readFileSync(join(root, "app", "api", "trade", "analyze", "route.ts"), "utf8");
const stream = readFileSync(join(root, "app", "api", "trade", "analyze-stream", "route.ts"), "utf8");
const history = readFileSync(join(root, "app", "api", "token-history", "route.ts"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(`[trade-analysis-contract] ${message}`);
}

for (const [label, source] of [["analyze", analyze], ["analyze-stream", stream]]) {
  assert(source.includes("const ANALYSIS_SCHEMA_VERSION = 3"), `${label}: stale analysis schema`);
  assert(source.includes("const MAX_TXS = 5000"), `${label}: MAX_TXS drifted`);
  assert(source.includes("const FRESH_CHECK_LIMIT = 30"), `${label}: freshness enrichment drifted`);
  assert(source.includes("const BALANCE_CHECK_LIMIT = 100"), `${label}: balance enrichment drifted`);
  assert(source.includes("const RAW_TRADES_IN_RESPONSE = 2000"), `${label}: response trade cap drifted`);
  assert(source.includes("const EARLY_TRADES_IN_RESPONSE = 400"), `${label}: early-trade sample drifted`);
  assert(!source.includes("amountSol * 150") && !source.includes("amountSol) * 150"), `${label}: fabricated $150/SOL conversion returned`);
  assert(!source.includes("totalVolumeUsd: 0"), `${label}: unavailable USD volume must not be encoded as zero`);
  assert(source.includes("u: null"), `${label}: raw trade USD notional must remain unknown without an oracle`);
  assert(source.includes("tokenBalanceUsd: null"), `${label}: unknown token USD balance must remain null`);
  assert(source.includes("washConfidence: wash.confidence"), `${label}: classifier confidence must not be hard-coded`);
  assert(source.includes("responseTradesTruncated"), `${label}: response truncation must be distinct from source-history truncation`);
}

assert(
  analyze.includes("return `analysis:v${ANALYSIS_SCHEMA_VERSION}:${mint}`"),
  "legacy JSON analysis must use its own cache namespace",
);
assert(
  stream.includes("return `analysis-stream:v${ANALYSIS_SCHEMA_VERSION}:${mint}`"),
  "NDJSON analysis must use its own cache namespace",
);
assert(
  analyze.includes("isFresh: freshnessVerified") && stream.includes("isFresh: freshnessVerified"),
  "wallet freshness must stay unknown until global first-seen verification succeeds",
);
assert(
  history.includes("Math.floor(Date.now() / 1000 / tfSec) * tfSec"),
  "mock candle timestamps must align to real timeframe bucket boundaries",
);
assert(
  history.includes('const forceMock = req.nextUrl.searchParams.get("mock") === "true"')
    && history.includes('source: "none"')
    && !history.includes("isDevelopment || forceMock"),
  "real history must never silently fall back to mock data",
);

console.log("[trade-analysis-contract] OK: cache isolation, unknown-value semantics, truncation and candle-bucket guards pass");
