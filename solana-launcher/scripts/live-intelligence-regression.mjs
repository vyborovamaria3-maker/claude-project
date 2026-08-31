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
const sourceNarrative = read("lib/trade/source-narrative-synthesis.ts");
const qwenSynthesis = read("lib/trade/qwen-synthesis.ts");
const socialAiRoute = read("app/api/trade/social-ai/route.ts");

function assert(condition, message) {
  if (!condition) throw new Error(`[live-intelligence-regression] ${message}`);
}

assert(panel.includes("buildCoverageAwareLiveIntelligence"), "live panel must use coverage-aware scoring");
assert(panel.includes("<IntelligenceNarrativeBundle"), "live panel must render the narrative bundle");
assert(panel.includes("currentSnapshot.features.some((feature) => !feature.missing)"), "Qwen must accept a structured snapshot without text evidence");
assert(!panel.includes("!currentSnapshot?.evidence.length"), "Qwen must not be gated only by text evidence");
assert(panel.includes("setAi({ available: false, error: message })"), "Qwen runtime errors must be visible in the AI card");
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
assert(sourceNarrative.includes("telegramCollector"), "Telegram narrative must consume collector coverage state");
assert(sourceNarrative.includes("monitor stopped"), "Telegram narrative must distinguish a stopped MTProto collector from an empty monitored index");
assert(sourceNarrative.includes('collector?.mode === "public_web"'), "Telegram narrative must recognize public-web fallback mode");
assert(sourceNarrative.includes("Telegram: публичное web-покрытие"), "public-web Telegram coverage must be explicit to the user");
assert(sourceNarrative.includes("private groups"), "public-web narrative must state private-group coverage limitations");
assert(qwenSynthesis.includes("Qwen-сервис выключен"), "Qwen synthesis must explain disabled service state");
assert(socialAiRoute.includes("if (!snapshot && !messages.length) return null"), "social AI route must allow snapshot-only full intelligence");

console.log("[live-intelligence-regression] OK: entry coverage, Telegram MTProto/public-web diagnostics, snapshot-only Qwen, persisted details and technical wiring are guarded");
