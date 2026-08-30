import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const panel = read("components/trade/LiveIntelligencePanel.tsx");
const bundle = read("components/trade/IntelligenceNarrativeBundle.tsx");
const persistence = read("components/trade/CollapsePersistence.tsx");
const coverage = read("lib/trade/intelligence-coverage.ts");
const liveSafe = read("lib/trade/live-intelligence-safe.ts");
const entrySafe = read("lib/trade/entry-thesis-safe.ts");
const entryCard = read("components/trade/EntryThesisCard.tsx");

function assert(condition, message) {
  if (!condition) throw new Error(`[live-intelligence-regression] ${message}`);
}

assert(panel.includes("buildCoverageAwareLiveIntelligence"), "live panel must use coverage-aware scoring");
assert(panel.includes("<IntelligenceNarrativeBundle"), "live panel must render the narrative bundle");
assert(bundle.includes("buildCoverageAwareEntryThesis"), "entry thesis must use coverage-aware wrapper");
assert(bundle.includes("hasFreshMarket"), "cross-source synthesis must filter stale market data");
assert(bundle.includes("<CollapsePersistence"), "live details persistence must be mounted");
assert(persistence.includes("localStorage"), "collapse state must persist per mint");
assert(persistence.includes('trade.live-intelligence.collapse:'), "collapse persistence must use a stable namespace");
assert(coverage.includes("market.meta?.stale !== true"), "stale market must not count as fresh evidence");
assert(coverage.includes("hasEarlyTimingEvidence"), "unknown early timing must have an explicit coverage check");
assert(liveSafe.includes("stale market: исключён из current-entry scoring"), "live scoring must exclude stale market from current-entry scoring");
assert(entrySafe.includes('priceState = "unknown"'), "entry thesis must report unknown price state without fresh market data");
assert(entrySafe.includes("неизвестное время сигнала не считается ни ранним, ни поздним"), "unknown timing must not be converted to a zero/late signal");
assert(entryCard.includes('data-tag="entry-thesis-technical-body"'), "entry thesis technical details must have visible content");

console.log("[live-intelligence-regression] OK: coverage-aware entry, stale-market guard, narrative bundle, persisted details and technical details are wired");
