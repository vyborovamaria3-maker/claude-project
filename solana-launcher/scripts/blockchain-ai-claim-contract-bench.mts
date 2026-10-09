import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const validatorUrl = new URL("../lib/trade/chain/ai-claim-validator.ts", import.meta.url);
const tempValidatorUrl = new URL("../lib/trade/chain/.tmp-ai-claim-validator-bench.mts", import.meta.url);
writeFileSync(tempValidatorUrl, readFileSync(validatorUrl, "utf8").replace('from "./ai-report-guard"', 'from "./ai-report-guard.ts"'));
const { evaluateBlockchainAiClaims, normalizeAiClaims } = await import(`${tempValidatorUrl.href}?v=${Date.now()}`);
process.on("exit", () => { try { unlinkSync(fileURLToPath(tempValidatorUrl)); } catch {} });

const facts = Array.from({ length: 80 }, (_, i) => ({ key: `metric.${i}`, value: i / 10, coverage: 0.9, confidence: 0.8 }));
facts.push({ key: "temporal.1h.observations", value: 100, coverage: 1, confidence: 1 });
facts.push({ key: "temporal.1h.demand.spearman", value: 0.4, coverage: 1, confidence: 1 });
const snapshot: any = {
  schemaVersion: "blockchain-ai-v1.1", mint: "M", generatedAt: 1, asOf: 1,
  cache: {}, reportContract: { requiredSections: [] }, headline: { contradictions: 0 },
  dataQuality: { chainTruncated: false, evidence: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`source${i}`, { available: true, complete: i % 3 !== 0, coveragePct: 80 + (i % 20), ageMs: 0 }])), sourceTimes: { sourceSkewMs: 0 } },
  sections: { flow: {}, holders: {}, wallets: {}, funding: {}, temporal: {}, devHistory: {} },
  facts, unknowns: Array.from({ length: 20 }, (_, i) => `unknown ${i}`), warnings: Array.from({ length: 20 }, (_, i) => `warning ${i}`),
  analysisIndex: {}, compactMeta: { payloadTruncated: false },
};
const rawClaims = Array.from({ length: 40 }, (_, i) => ({
  id: `claim-${i}`,
  claim: i % 5 === 0 ? `Temporal association ${i} does not establish causality.` : `Observed metric ${i} is available.`,
  claimType: i % 5 === 0 ? "temporal_backtest" : "observed_fact",
  evidenceKeys: i % 5 === 0 ? ["temporal.1h.observations", "temporal.1h.demand.spearman"] : [`metric.${i % 80}`],
  confidence: 0.7,
  timeScope: i % 5 === 0 ? "temporal_backtest" : "current",
}));
const parsed = normalizeAiClaims(rawClaims);
for (let i = 0; i < 100; i++) evaluateBlockchainAiClaims({ snapshot, claims: parsed.claims, parseIssues: [], globalConfidenceCap01: 0.85, reportConfidence01: 0.8 });
const samples: number[] = [];
for (let i = 0; i < 1000; i++) {
  const start = performance.now();
  evaluateBlockchainAiClaims({ snapshot, claims: parsed.claims, parseIssues: [], globalConfidenceCap01: 0.85, reportConfidence01: 0.8 });
  samples.push(performance.now() - start);
}
samples.sort((a,b) => a-b);
const avg = samples.reduce((a,b) => a+b,0) / samples.length;
const median = samples[Math.floor(samples.length * 0.5)];
const p95 = samples[Math.floor(samples.length * 0.95)];
const p99 = samples[Math.floor(samples.length * 0.99)];
console.log(JSON.stringify({ iterations: samples.length, claimsPerReport: 40, evidenceKeys: 80 + 12 + 6 + 20 + 20 + 2, avgMs: avg, medianMs: median, p95Ms: p95, p99Ms: p99 }, null, 2));
