import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const validatorUrl = new URL("../lib/trade/chain/ai-claim-validator.ts", import.meta.url);
const tempValidatorUrl = new URL("../lib/trade/chain/.tmp-ai-claim-validator.mts", import.meta.url);
const validatorSource = readFileSync(validatorUrl, "utf8").replace('from "./ai-report-guard"', 'from "./ai-report-guard.ts"');
writeFileSync(tempValidatorUrl, validatorSource);
const { buildClaimEvidenceCatalog, evaluateBlockchainAiClaims, normalizeAiClaims } = await import(`${tempValidatorUrl.href}?v=${Date.now()}`);
process.on("exit", () => { try { unlinkSync(fileURLToPath(tempValidatorUrl)); } catch {} });

const snapshot: any = {
  schemaVersion: "blockchain-ai-v1.1",
  mint: "Mint1111111111111111111111111111111111111",
  generatedAt: 1_800_000_000_000,
  asOf: 1_800_000_000_000,
  cache: { chainHit: true, chainSource: "cache", chainAgeMs: 1_000, devSource: "cache" },
  reportContract: { requiredSections: [], claimContract: { version: "blockchain-claim-v1" } },
  headline: { lifecycle: { stage: "acceleration", confidence: 0.7 }, scores: {}, evidenceCompletenessPct: 70, safetyFails: 0, safetyWarnings: 1, safetyUnknown: 1, contradictions: 1 },
  dataQuality: {
    chainTruncated: false,
    evidence: {
      recentTrades: { available: true, complete: false, coveragePct: 80, source: "mock", fetchedAt: 1_800_000_000_000, ageMs: 0, futureByMs: 0 },
      funding: { available: true, complete: true, coveragePct: 100, source: "mock", fetchedAt: 1_800_000_000_000, ageMs: 0, futureByMs: 0 },
      market: { available: true, complete: true, coveragePct: 100, source: "mock", fetchedAt: 1_800_000_000_000, ageMs: 0, futureByMs: 0 },
    },
    sourceTimes: { chainAsOf: 1_800_000_000_000, devFetchedAt: 1_800_000_000_000, generatedAt: 1_800_000_000_000, sourceSkewMs: 0 },
    evidenceCompletenessSemantics: "mock",
    listStats: { unknownsTotal: 1, unknownsIncluded: 1, warningsTotal: 1, warningsIncluded: 1 },
    devHistoryAvailable: true,
    devHistoryWarning: null,
  },
  sections: {
    safety: {}, liquidity: {}, holders: {}, flow: {}, wallets: {}, bundles: {}, funding: {}, wash: {}, creator: {}, devHistory: {}, temporal: { outcomeReplay: true }, contradictions: [{}], anomalies: [], events: [],
  },
  facts: [
    { key: "flow.ofi_15m", value: 0.4, coverage: 0.8, coverageScale: "share01" },
    { key: "flow.ofi_1h", value: null, coverage: 0.3, coverageScale: "share01" },
    { key: "funding.verified_edges", value: 4 },
    { key: "score.coordination", value: 64, confidence: 0.7, confidenceScale: "share01" },
    { key: "temporal.1h.observations", value: 28 },
    { key: "temporal.1h.demand.spearman", value: 0.42, valueScale: "signed11" },
  ],
  unknowns: ["recentTrades partial evidence"],
  warnings: ["flow/price divergence"],
  analysisIndex: { qualityV1: true, qualityV34: true, qualityV35: true, devHistory: true },
  compactMeta: { stringsAreUntrustedData: true, maxStringChars: 4000, maxArrayItems: 120, payloadBudgetBytes: 220000, payloadBytes: 10000, payloadTruncated: false, compactionLevel: "standard" },
};

const catalog = buildClaimEvidenceCatalog(snapshot);
assert(catalog.has("flow.ofi_15m"));
assert(catalog.has("evidence.recentTrades"));
assert(catalog.has("section.temporal"));
assert(catalog.has("unknown.1"));
assert(catalog.has("warning.1"));

const parsed = normalizeAiClaims([
  { id: "c1", claim: "OFI 15m is positive in the observed window.", claimType: "observed_fact", evidenceKeys: ["flow.ofi_15m"], evidenceAssertions: [{ key: "flow.ofi_15m", operator: "gt", value: 0 }], confidence: 0.75, timeScope: "current" },
  { id: "c2", claim: "The temporal replay shows a positive demand association at 1h.", claimType: "temporal_backtest", evidenceKeys: ["temporal.1h.demand.spearman", "temporal.1h.observations"], confidence: 0.7, timeScope: "temporal_backtest" },
  { id: "c3", claim: "Recent trade coverage is incomplete.", claimType: "limitation", evidenceKeys: ["evidence.recentTrades", "unknown.1"], confidence: 0.8, timeScope: "current" },
  { id: "c4", claim: "Funding links are observed, but they do not prove common ownership or insider control.", claimType: "limitation", evidenceKeys: ["funding.verified_edges", "evidence.funding"], confidence: 0.8, timeScope: "current" },
]);
assert.equal(parsed.parseIssues.length, 0);
const good = evaluateBlockchainAiClaims({ snapshot, claims: parsed.claims, parseIssues: parsed.parseIssues, globalConfidenceCap01: 0.85, reportConfidence01: 0.8 });
assert.equal(good.status, "verified");
assert.equal(good.claimsVerified, 4);
assert.equal(good.claimsRejected, 0);
assert(good.claims[0].evidenceCap01 <= 0.8 + 1e-9, "OFI claim cap must honor 80% coverage");

const over = normalizeAiClaims([
  { id: "o1", claim: "These funded wallets are controlled by the same owner and are insiders.", claimType: "interpretation", evidenceKeys: ["funding.verified_edges", "evidence.funding"], confidence: 0.95, timeScope: "current" },
  { id: "o2", claim: "The 1h OFI is strong.", claimType: "observed_fact", evidenceKeys: ["flow.ofi_1h"], confidence: 0.9, timeScope: "current" },
  { id: "o3", claim: "The backtest proves price rises because of demand momentum.", claimType: "temporal_backtest", evidenceKeys: ["temporal.1h.demand.spearman"], confidence: 0.9, timeScope: "temporal_backtest" },
  { id: "o4", claim: "This token will definitely rise.", claimType: "future_outlook", evidenceKeys: ["flow.ofi_15m"], confidence: 0.8, timeScope: "current" },
  { id: "o5", claim: "Unknown key claim.", claimType: "observed_fact", evidenceKeys: ["does.not.exist"], confidence: 0.5, timeScope: "current" },
  { id: "o6", claim: "OFI 15m is negative.", claimType: "observed_fact", evidenceKeys: ["flow.ofi_15m"], evidenceAssertions: [{ key: "flow.ofi_15m", operator: "lt", value: 0 }], confidence: 0.7, timeScope: "current" },
]);
const bad = evaluateBlockchainAiClaims({ snapshot, claims: over.claims, parseIssues: over.parseIssues, globalConfidenceCap01: 0.85, reportConfidence01: 0.9 });
assert.equal(bad.status, "reject");
assert(bad.claims.find((row) => row.id === "o1")?.violations.some((row) => row.severity === "critical"), "funding ownership overclaim must be critical");
assert(bad.claims.find((row) => row.id === "o2")?.violations.some((row) => row.code === "claim_unavailable_evidence"), "null evidence must not support observed fact");
assert(bad.claims.find((row) => row.id === "o3")?.violations.some((row) => row.textGuardCode === "correlation_causality_overclaim"), "correlation causality must be detected");
assert(bad.claims.find((row) => row.id === "o4")?.violations.some((row) => row.textGuardCode === "deterministic_future_prediction"), "deterministic future claim must be detected");
assert(bad.claims.find((row) => row.id === "o5")?.violations.some((row) => row.code === "claim_unknown_evidence_key"), "invented evidence key must be detected");
assert(bad.claims.find((row) => row.id === "o6")?.violations.some((row) => row.code === "claim_evidence_assertion_failed"), "evidence assertion must catch sign/value inversion");

const missing = evaluateBlockchainAiClaims({ snapshot, claims: [], parseIssues: [], globalConfidenceCap01: 0.9, reportConfidence01: 0.9 });
assert.equal(missing.status, "missing");
assert.equal(missing.mode, "text_guard_only");
assert.equal(missing.confidenceCap01, 0.65);
assert.equal(missing.effectiveConfidence01, 0.65);

const invalidShape = normalizeAiClaims({ claim: "not an array" });
assert.equal(invalidShape.claims.length, 0);
assert.equal(invalidShape.parseIssues.length, 1);

console.log(`PASS blockchain AI claim contract regression; evidenceKeys=${catalog.size}; verified=${good.claimsVerified}; rejected=${bad.claimsRejected}`);
