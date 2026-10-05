import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const validatorUrl = new URL("../lib/trade/chain/ai-claim-validator.ts", import.meta.url);
const tempValidatorUrl = new URL("../lib/trade/chain/.tmp-ai-claim-validator-fuzz.mts", import.meta.url);
writeFileSync(tempValidatorUrl, readFileSync(validatorUrl, "utf8").replace('from "./ai-report-guard"', 'from "./ai-report-guard.ts"'));
const { evaluateBlockchainAiClaims, normalizeAiClaims } = await import(`${tempValidatorUrl.href}?v=${Date.now()}`);
process.on("exit", () => { try { unlinkSync(fileURLToPath(tempValidatorUrl)); } catch {} });

const snapshot: any = {
  schemaVersion: "blockchain-ai-v1.1", mint: "M", generatedAt: 1, asOf: 1,
  cache: {}, reportContract: { requiredSections: [] }, headline: { contradictions: 0 },
  dataQuality: {
    chainTruncated: false,
    evidence: {
      recentTrades: { available: true, complete: false, coveragePct: 60, ageMs: 0 },
      funding: { available: true, complete: true, coveragePct: 100, ageMs: 0 },
    }, sourceTimes: { sourceSkewMs: 0 },
  },
  sections: { flow: {}, funding: {}, temporal: {} },
  facts: [
    { key: "flow.ofi_15m", value: 0.3, coverage: 0.6 },
    { key: "funding.verified_edges", value: 3 },
    { key: "temporal.1h.observations", value: 20 },
    { key: "temporal.1h.demand.spearman", value: 0.4 },
  ],
  unknowns: ["recent trades partial"], warnings: [],
  analysisIndex: {}, compactMeta: { payloadTruncated: false },
};

const cases: Array<{ bad: boolean; raw: any; expected?: string }> = [];
for (let i = 0; i < 250; i++) cases.push({ bad: false, raw: { claim: `Observed OFI is positive in sample ${i}.`, claimType: "observed_fact", evidenceKeys: ["flow.ofi_15m"], confidence: 0.55, timeScope: "current" } });
for (let i = 0; i < 150; i++) cases.push({ bad: false, raw: { claim: `Temporal replay shows an association in sample ${i}; this does not establish causality.`, claimType: "temporal_backtest", evidenceKeys: ["temporal.1h.observations", "temporal.1h.demand.spearman"], confidence: 0.55, timeScope: "temporal_backtest" } });
for (let i = 0; i < 100; i++) cases.push({ bad: true, expected: "claim_unknown_evidence_key", raw: { claim: `Unknown evidence claim ${i}.`, claimType: "observed_fact", evidenceKeys: [`invented.${i}`], confidence: 0.5, timeScope: "current" } });
for (let i = 0; i < 150; i++) cases.push({ bad: true, expected: "claim_partial_evidence_overconfidence", raw: { claim: `OFI claim with excessive confidence ${i}.`, claimType: "observed_fact", evidenceKeys: ["flow.ofi_15m"], confidence: 0.99, timeScope: "current" } });
for (let i = 0; i < 50; i++) cases.push({ bad: true, expected: "claim_evidence_assertion_failed", raw: { claim: `OFI is negative ${i}.`, claimType: "observed_fact", evidenceKeys: ["flow.ofi_15m"], evidenceAssertions: [{ key: "flow.ofi_15m", operator: "lt", value: 0 }], confidence: 0.5, timeScope: "current" } });
for (let i = 0; i < 100; i++) cases.push({ bad: true, expected: "claim_text_overclaim", raw: { claim: `Funding proves these wallets are controlled by the same owner ${i}.`, claimType: "interpretation", evidenceKeys: ["funding.verified_edges"], confidence: 0.8, timeScope: "current" } });
for (let i = 0; i < 100; i++) cases.push({ bad: true, expected: "claim_temporal_without_temporal_evidence", raw: { claim: `Backtest association ${i}.`, claimType: "temporal_backtest", evidenceKeys: ["flow.ofi_15m"], confidence: 0.5, timeScope: "temporal_backtest" } });
for (let i = 0; i < 100; i++) cases.push({ bad: true, expected: "claim_text_overclaim", raw: { claim: `The token will definitely rise ${i}.`, claimType: "future_outlook", evidenceKeys: ["flow.ofi_15m"], confidence: 0.8, timeScope: "future_conditional" } });

let bad = 0, badCaught = 0, good = 0, falsePositives = 0;
const failures: any[] = [];
for (let i = 0; i < cases.length; i++) {
  const item = cases[i];
  const parsed = normalizeAiClaims([{ id: `c${i}`, ...item.raw }]);
  const audit = evaluateBlockchainAiClaims({ snapshot, claims: parsed.claims, parseIssues: parsed.parseIssues, globalConfidenceCap01: 0.85, reportConfidence01: 0.7 });
  const codes = audit.violations.map((row: any) => row.code);
  if (item.bad) {
    bad++;
    if (item.expected && codes.includes(item.expected)) badCaught++;
    else failures.push({ i, expected: item.expected, codes, raw: item.raw });
  } else {
    good++;
    if (audit.status !== "verified") {
      falsePositives++;
      failures.push({ i, status: audit.status, codes, raw: item.raw });
    }
  }
}
assert.equal(cases.length, 1000);
assert.equal(badCaught, bad, `missed bad claim cases: ${JSON.stringify(failures.slice(0, 5))}`);
assert.equal(falsePositives, 0, `false positives: ${JSON.stringify(failures.slice(0, 5))}`);
console.log(JSON.stringify({ total: cases.length, bad, badCaught, recall: badCaught / bad, good, falsePositives, falsePositiveRate: falsePositives / good, failures }, null, 2));
