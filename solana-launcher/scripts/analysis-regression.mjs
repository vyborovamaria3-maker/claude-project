import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const metricsPath = join(root, "lib", "trade", "social-intelligence.ts");
const layoutPath = join(root, "app", "trade", "analysis", "layout.tsx");
const panelPath = join(root, "components", "trade", "SocialIntelligencePanel.tsx");
const chartPath = join(root, "components", "trade", "SocialAnalysisChart.tsx");
const activityPath = join(root, "components", "chart", "ActivityPanel.tsx");
const routePath = join(root, "app", "api", "trade", "social-ai", "route.ts");
const tokenHistoryPath = join(root, "app", "api", "token-history", "route.ts");
const tokenTradesPath = join(root, "app", "api", "token-trades", "route.ts");
const analyzePath = join(root, "app", "api", "trade", "analyze", "route.ts");
const analyzeStreamPath = join(root, "app", "api", "trade", "analyze-stream", "route.ts");
const socialApiPath = join(root, "lib", "trade", "social-intelligence-api.ts");
const ohlcvHookPath = join(root, "hooks", "useOHLCV.ts");
const tradeStreamPath = join(root, "hooks", "useTradeStream.ts");
const proxyPath = join(root, "proxy.ts");
const wrapperPath = join(root, "lib", "trade", "intelligence-agent-provenance.ts");
const provenancePath = join(root, "lib", "trade", "analysis-feature-provenance.json");
const tsconfigPath = join(root, "tsconfig.json");

const metricsSource = readFileSync(metricsPath, "utf8");
const layoutSource = readFileSync(layoutPath, "utf8");
const panelSource = readFileSync(panelPath, "utf8");
const chartSource = readFileSync(chartPath, "utf8");
const activitySource = readFileSync(activityPath, "utf8");
const routeSource = readFileSync(routePath, "utf8");
const tokenHistorySource = readFileSync(tokenHistoryPath, "utf8");
const tokenTradesSource = readFileSync(tokenTradesPath, "utf8");
const analyzeSource = readFileSync(analyzePath, "utf8");
const analyzeStreamSource = readFileSync(analyzeStreamPath, "utf8");
const socialApiSource = readFileSync(socialApiPath, "utf8");
const ohlcvHookSource = readFileSync(ohlcvHookPath, "utf8");
const tradeStreamSource = readFileSync(tradeStreamPath, "utf8");
const proxySource = readFileSync(proxyPath, "utf8");
const wrapperSource = readFileSync(wrapperPath, "utf8");
const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(`[analysis-regression] ${message}`);
}

assert(
  layoutSource.includes('href: "/trade/analysis/social"'),
  "the Social Intelligence route must remain in the Trade Analysis tabs",
);
assert(
  layoutSource.includes('label: "Анализ · 129"'),
  "the visible 129-parameter Analysis tab must remain present",
);
assert(
  panelSource.includes("Технические детали")
    && panelSource.includes("technicalOpen")
    && panelSource.includes("derived.groups.map"),
  "the full parameter table must remain available behind the lazy technical-details control",
);
assert(
  panelSource.includes('from "@/lib/trade/intelligence-agent"'),
  "Social Intelligence must build snapshots through the intelligence-agent alias",
);
assert(
  routeSource.includes('from "@/lib/trade/intelligence-agent"'),
  "social-ai route must consume the same intelligence snapshot contract",
);
assert(
  panelSource.includes("<SourceHealthBar")
    && panelSource.includes('data-tag="trade.social_source_health.v2"'),
  "Social Intelligence must expose truthful per-source runtime health",
);
assert(
  panelSource.includes("<OverallVerdict")
    && panelSource.includes('data-tag="trade.social_overall_verdict.v2"')
    && panelSource.includes("Social coverage")
    && panelSource.includes("Core coverage"),
  "Social Intelligence must distinguish social coverage from generic core coverage",
);
assert(
  panelSource.includes('const hasSocialData = Boolean(x || tg)')
    && panelSource.includes('value={hasSocialData ? score(derived.socialScore) : "—"}')
    && panelSource.includes('value={hasSocialData ? score(derived.socialRisk) : "—"}'),
  "market/chain-only coverage must never render SOCIAL/RISK as real 0/100 values",
);
assert(
  panelSource.includes('ai?.provider === "mock"')
    && panelSource.includes("MOCK · NOT QWEN")
    && panelSource.includes('provider === "openai-compatible"'),
  "mock AI output must never be presented as a real Qwen verdict",
);
assert(
  !panelSource.includes("RecentTradesCard"),
  "Social Intelligence must not render the removed duplicate recent-trades table",
);

assert(
  chartSource.includes('from "@/components/chart/ActivityPanel"')
    && chartSource.includes("<ActivityPanel mint={mint} />"),
  "the social terminal must reuse the shared live transaction panel on the right side",
);
assert(
  activitySource.includes("useTradeStream(mint, 100)"),
  "the shared transaction panel must remain backed by the live trade stream",
);
assert(
  chartSource.includes('{ value: "1s", label: "1s" }')
    && chartSource.includes('{ value: "5s", label: "5s" }')
    && chartSource.includes('{ value: "15s", label: "15s" }'),
  "the social terminal must preserve second-level timeframes",
);
assert(
  chartSource.includes('useState<MetricMode>("mcap")')
    && chartSource.includes("MarketReference")
    && chartSource.includes("cap / price")
    && chartSource.includes("marketReference.supply"),
  "market-cap mode must derive supply from a market reference instead of assuming 1B for every mint",
);
assert(
  chartSource.includes("useTradeStream(")
    && chartSource.includes("ingestTrade({")
    && chartSource.includes("liveTradesOnline"),
  "live trades must feed the shared OHLC aggregator instead of relying only on history polling",
);
assert(
  chartSource.includes('chart.priceScale("volume").applyOptions({')
    && chartSource.includes("lastValueVisible: false")
    && chartSource.includes("visible: false"),
  "volume must stay visually separated from the right MC/price scale",
);
assert(
  !chartSource.includes("[&+section]:hidden"),
  "the terminal must not rely on a sibling-hiding CSS hack for duplicate trades",
);

assert(
  tokenHistorySource.includes('const forceMock = req.nextUrl.searchParams.get("mock") === "true"')
    && tokenHistorySource.includes('source: "none"')
    && tokenHistorySource.includes('priceUnit: "token_usd"')
    && !tokenHistorySource.includes("isDevelopment || forceMock"),
  "token-history must use real data by default and mock data only by explicit opt-in",
);
assert(
  tokenHistorySource.includes('"1s": 1')
    && tokenHistorySource.includes('"5s": 5')
    && tokenHistorySource.includes('"15s": 15')
    && tokenHistorySource.includes("TF_SECONDS[timeframe]"),
  "mock sub-minute candles must use real second spacing rather than minute spacing",
);
assert(
  tokenHistorySource.includes("new PublicKey(mint)")
    && tokenHistorySource.includes("VALID_TIMEFRAMES.has(timeframe)"),
  "token-history must reject invalid mints and unsupported timeframes",
);
assert(
  !ohlcvHookSource.includes("c.close > 1")
    && ohlcvHookSource.includes("API contract: all candle OHLC values are per-token USD prices"),
  "the client must never infer candle units from price magnitude",
);
assert(
  !ohlcvHookSource.includes("aggregators.delete(mint)"),
  "the current mint aggregator must remain shared across chart consumers",
);

assert(
  tokenTradesSource.includes("upstream unavailable")
    && tokenTradesSource.includes("status: 502")
    && tokenTradesSource.includes("status: 503"),
  "live-trade upstream failures must surface as errors instead of fake successful empty arrays",
);
assert(
  !tradeStreamSource.includes("|| 150")
    && tradeStreamSource.includes("upstreamAmountUsd")
    && tradeStreamSource.includes("p.seenSigs.add(row.signature)"),
  "live trades must not fabricate USD prices and must validate rows before consuming signatures",
);
assert(
  socialApiSource.includes("stream ended before final payload"),
  "an interrupted chain NDJSON stream must not be mistaken for a valid empty analysis",
);
assert(
  proxySource.includes('"/api/trade/dev-twitter"')
    && proxySource.includes('"/api/trade/social-ai"'),
  "expensive X and Qwen routes must remain under the heavy-route rate limiter",
);

for (const [label, source] of [["analyze", analyzeSource], ["analyze-stream", analyzeStreamSource]]) {
  assert(
    source.includes("const ANALYSIS_SCHEMA_VERSION = 3")
      && source.includes("const MAX_TXS = 5000")
      && source.includes("const FRESH_CHECK_LIMIT = 30")
      && source.includes("const BALANCE_CHECK_LIMIT = 100")
      && source.includes("const RAW_TRADES_IN_RESPONSE = 2000")
      && source.includes("const EARLY_TRADES_IN_RESPONSE = 400"),
    `${label} must use the same canonical v3 analysis limits so the shared cache cannot change semantics by endpoint order`,
  );
  assert(
    !source.includes("amountSol * 150")
      && !source.includes("amountSol) * 150")
      && !source.includes("totalVolumeUsd: 0")
      && source.includes("u: null"),
    `${label} must keep USD unknown unless backed by a real price oracle`,
  );
  assert(
    source.includes("tokenBalanceUsd: null")
      && source.includes("solBalances.get(")
      && source.includes("?? null")
      && source.includes("washConfidence: wash.confidence")
      && source.includes("responseTradesTruncated"),
    `${label} must distinguish unknown balances, classifier confidence, input truncation and response truncation`,
  );
}
assert(
  analyzeSource.includes("isFresh: freshnessVerified")
    && analyzeStreamSource.includes("isFresh: freshnessVerified"),
  "wallet freshness must remain unknown until global first-seen enrichment actually verifies it",
);

const intelligenceAlias = tsconfig?.compilerOptions?.paths?.["@/lib/trade/intelligence-agent"];
assert(
  Array.isArray(intelligenceAlias)
    && intelligenceAlias.includes("./lib/trade/intelligence-agent-provenance"),
  "intelligence-agent alias must route through the provenance layer",
);
assert(
  wrapperSource.includes("snapshot.features.map(enrichFeature)"),
  "provenance layer must enrich every snapshot feature",
);
assert(
  wrapperSource.includes("includedInAgentSnapshot: true"),
  "every catalog feature must explicitly declare snapshot inclusion",
);
assert(
  wrapperSource.includes("allCoreMapped"),
  "provenance layer must report 129-core mapping coverage",
);

assert(
  provenance?.version === "feature-provenance-v1",
  `unexpected provenance catalog version: ${String(provenance?.version)}`,
);
assert(
  provenance?.coreFeatureCount === 129,
  `provenance core catalog must equal 129, found ${String(provenance?.coreFeatureCount)}`,
);
assert(
  provenance?.groups && typeof provenance.groups === "object",
  "provenance catalog groups are missing",
);

const allowedSources = new Set(["derived", "x", "telegram", "market", "chain", "ai"]);
const allowedRoles = new Set(["input", "ai_output"]);

function validateRule(rule, context) {
  assert(rule && typeof rule === "object", `${context}: mapping rule is missing`);
  assert(allowedSources.has(rule.source), `${context}: invalid primary source ${String(rule.source)}`);
  assert(Array.isArray(rule.sources) && rule.sources.length > 0, `${context}: sources must be non-empty`);
  for (const source of rule.sources) {
    assert(allowedSources.has(source), `${context}: invalid source ${String(source)}`);
  }
  assert(allowedRoles.has(rule.role), `${context}: invalid role ${String(rule.role)}`);
}

const groupsStart = metricsSource.indexOf('const groups: DerivedSocial["groups"] = [');
const groupsEnd = metricsSource.indexOf("\n  return {", groupsStart);
assert(groupsStart >= 0 && groupsEnd > groupsStart, "unable to locate derived Social Intelligence groups");

const groupsSource = metricsSource.slice(groupsStart, groupsEnd);
const groupMatches = [...groupsSource.matchAll(/title: "([^"]+)",\s*\n\s*rows: \[/g)];
assert(groupMatches.length === 6, `expected 6 parameter groups, found ${groupMatches.length}`);

let coreCount = 0;
let totalCount = 0;
let aiOutputCount = 0;
let inputCount = 0;
const seenGroups = new Set();

for (let index = 0; index < groupMatches.length; index += 1) {
  const current = groupMatches[index];
  const next = groupMatches[index + 1];
  const title = current[1];
  const sliceStart = current.index ?? 0;
  const sliceEnd = next?.index ?? groupsSource.length;
  const groupSource = groupsSource.slice(sliceStart, sliceEnd);
  const labels = [...groupSource.matchAll(/\bmetric\("([^"]+)"/g)].map((match) => match[1]);
  const catalogGroup = provenance.groups[title];

  assert(catalogGroup, `missing provenance group: ${title}`);
  seenGroups.add(title);
  assert(Number.isInteger(catalogGroup.coreCount), `${title}: coreCount must be an integer`);
  assert(catalogGroup.coreCount >= 0, `${title}: coreCount cannot be negative`);
  assert(catalogGroup.coreCount <= labels.length, `${title}: coreCount exceeds displayed rows`);
  assert(Array.isArray(catalogGroup.labels), `${title}: labels catalog is missing`);
  assert(
    catalogGroup.labels.length === labels.length,
    `${title}: UI/catalog row count mismatch (${labels.length} != ${catalogGroup.labels.length})`,
  );

  for (let labelIndex = 0; labelIndex < labels.length; labelIndex += 1) {
    const uiLabel = labels[labelIndex];
    const catalogLabel = catalogGroup.labels[labelIndex];
    assert(
      uiLabel === catalogLabel,
      `${title}: parameter ${labelIndex + 1} drifted (${JSON.stringify(uiLabel)} != ${JSON.stringify(catalogLabel)})`,
    );
  }

  validateRule(catalogGroup.default, `${title} default`);
  for (const [label, rule] of Object.entries(catalogGroup.overrides || {})) {
    assert(catalogGroup.labels.includes(label), `${title}: override references unknown parameter ${label}`);
    validateRule(rule, `${title} / ${label}`);
  }

  for (const label of labels) {
    const rule = catalogGroup.overrides?.[label] || catalogGroup.default;
    validateRule(rule, `${title} / ${label}`);
    if (rule.role === "ai_output") aiOutputCount += 1;
    else inputCount += 1;
  }

  coreCount += catalogGroup.coreCount;
  totalCount += labels.length;
}

for (const catalogGroupName of Object.keys(provenance.groups)) {
  assert(seenGroups.has(catalogGroupName), `catalog contains stale group: ${catalogGroupName}`);
}

assert(coreCount === 129, `core catalog must equal 129 parameters, found ${coreCount}`);
assert(
  coreCount === provenance.coreFeatureCount,
  `UI core and provenance core disagree (${coreCount} != ${provenance.coreFeatureCount})`,
);
assert(
  totalCount >= coreCount,
  `full catalog cannot be smaller than the 129-parameter core (${totalCount})`,
);
assert(
  inputCount + aiOutputCount === totalCount,
  `every displayed parameter must resolve to input or ai_output (${inputCount} + ${aiOutputCount} != ${totalCount})`,
);

const extendedCount = totalCount - coreCount;
console.log(
  `[analysis-regression] OK: ${coreCount}/129 core mapped; ${totalCount}/${totalCount} displayed rows covered; `
  + `${inputCount} agent-input features + ${aiOutputCount} AI-output placeholders; ${extendedCount} extended rows; social terminal/data-integrity guards OK`,
);
