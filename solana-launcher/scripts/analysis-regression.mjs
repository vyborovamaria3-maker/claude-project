import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const metricsPath = join(root, "lib", "trade", "social-intelligence.ts");
const layoutPath = join(root, "app", "trade", "analysis", "layout.tsx");
const panelPath = join(root, "components", "trade", "SocialIntelligencePanel.tsx");

const metricsSource = readFileSync(metricsPath, "utf8");
const layoutSource = readFileSync(layoutPath, "utf8");
const panelSource = readFileSync(panelPath, "utf8");

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
  panelSource.includes('>Все параметры</h2>'),
  "the full parameter table must remain visible in Social Intelligence",
);

const groupsStart = metricsSource.indexOf('const groups: DerivedSocial["groups"] = [');
const groupsEnd = metricsSource.indexOf("\n  return {\n    groups,", groupsStart);
assert(groupsStart >= 0 && groupsEnd > groupsStart, "unable to locate derived Social Intelligence groups");

const groupsSource = metricsSource.slice(groupsStart, groupsEnd);
const groupMatches = [...groupsSource.matchAll(/title: "([^"]+)",\s*\n\s*rows: \[/g)];
assert(groupMatches.length === 6, `expected 6 parameter groups, found ${groupMatches.length}`);

const coreCounts = new Map([
  ["X / Twitter", 39],
  ["Telegram", 28],
  ["Growth / Quality / Manipulation", 16],
  ["Cross-platform / Timing", 24],
  ["Price event evidence", 12],
  ["AI Agent / Evidence", 10],
]);

let coreCount = 0;
let totalCount = 0;
for (let index = 0; index < groupMatches.length; index += 1) {
  const current = groupMatches[index];
  const next = groupMatches[index + 1];
  const title = current[1];
  const sliceStart = current.index ?? 0;
  const sliceEnd = next?.index ?? groupsSource.length;
  const groupSource = groupsSource.slice(sliceStart, sliceEnd);
  const currentCount = (groupSource.match(/\bmetric\("/g) || []).length;
  const requiredCoreCount = coreCounts.get(title);

  assert(requiredCoreCount != null, `unexpected parameter group: ${title}`);
  assert(
    currentCount >= requiredCoreCount,
    `${title} dropped below its 129-core allocation (${currentCount} < ${requiredCoreCount})`,
  );

  coreCount += requiredCoreCount;
  totalCount += currentCount;
}

assert(coreCount === 129, `core catalog must equal 129 parameters, found ${coreCount}`);
assert(
  totalCount >= coreCount,
  `full catalog cannot be smaller than the 129-parameter core (${totalCount})`,
);

const extendedCount = totalCount - coreCount;
console.log(`[analysis-regression] OK: ${coreCount} core parameters + ${extendedCount} extended rows (${totalCount} displayed rows total)`);
