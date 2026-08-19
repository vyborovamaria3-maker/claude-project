import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const metricsPath = join(root, "lib", "trade", "social-intelligence.ts");
const layoutPath = join(root, "app", "trade", "analysis", "layout.tsx");
const xPagePath = join(root, "app", "trade", "analysis", "x", "page.tsx");
const panelPath = join(root, "components", "trade", "SocialIntelligencePanel.tsx");
const routePath = join(root, "app", "api", "trade", "social-ai", "route.ts");
const wrapperPath = join(root, "lib", "trade", "intelligence-agent-provenance.ts");
const provenancePath = join(root, "lib", "trade", "analysis-feature-provenance.json");
const tsconfigPath = join(root, "tsconfig.json");

const metricsSource = readFileSync(metricsPath, "utf8").replace(/\r\n?/g, "\n");
const layoutSource = readFileSync(layoutPath, "utf8");
const xPageSource = readFileSync(xPagePath, "utf8");
const panelSource = readFileSync(panelPath, "utf8");
const routeSource = readFileSync(routePath, "utf8");
const wrapperSource = readFileSync(wrapperPath, "utf8");
const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(`[analysis-regression] ${message}`);
}

assert(
  layoutSource.includes('href: "/trade/analysis/x"'),
  "the unified X Intelligence route must remain in the Trade Analysis tabs",
);
assert(
  layoutSource.includes('label: "X"'),
  "the visible X Intelligence tab must remain present",
);
assert(
  xPageSource.includes('SocialIntelligencePanel'),
  "the X route must render the unified X + Telegram + blockchain intelligence panel",
);
assert(
  panelSource.includes('>Все параметры</h2>'),
  "the full parameter table must remain visible in Social Intelligence",
);
assert(
  panelSource.includes('from "@/lib/trade/intelligence-agent"'),
  "Social Intelligence must build snapshots through the intelligence-agent alias",
);
assert(
  routeSource.includes('from "@/lib/trade/intelligence-agent"'),
  "social-ai route must consume the same intelligence snapshot contract",
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
const groupsEnd = metricsSource.indexOf("\n  return {\n    groups,", groupsStart);
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
  + `${inputCount} agent-input features + ${aiOutputCount} AI-output placeholders; ${extendedCount} extended rows`,
);
