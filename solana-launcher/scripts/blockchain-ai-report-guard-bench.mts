import { performance } from "node:perf_hooks";
import { evaluateBlockchainAiReport, type GuardableAiReport, type GuardSnapshot } from "../lib/trade/chain/ai-report-guard.ts";

const sections = ["current_state","market_flow","holders_distribution","wallets_smart_money","bundles_funding_coordination","wash_anomalies","dev_history","temporal_backtest","contradictions","unknowns","final_assessment"];
const snapshot: GuardSnapshot = {
  headline: { contradictions: 3 },
  dataQuality: {
    chainTruncated: false,
    evidence: Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`e${i}`, { available: true, complete: i % 3 === 0, coveragePct: i % 3 === 0 ? 100 : 55 + (i % 5) * 5 }])),
    sourceTimes: { sourceSkewMs: 120_000 },
  },
  unknowns: Array.from({ length: 14 }, (_, i) => `unknown ${i}`),
  compactMeta: { payloadTruncated: false },
  reportContract: { requiredSections: sections },
};
const report: GuardableAiReport = {
  summary: "Funding may indicate a relationship but does not prove common ownership. Positive flow is descriptive; future outcome remains uncertain.",
  overallConfidence: 0.72,
  reasoningSummary: Array.from({ length: 12 }, (_, i) => `Reason ${i}: correlation is descriptive and does not establish causality.`),
  finalIntelligence: { marketState: "mixed", manipulationAssessment: "uncertain", bullCase: "conditional", bearCase: "partial coverage", unknowns: ["partial evidence"], confidence: 0.72 },
  risks: Array.from({ length: 12 }, (_, i) => ({ label: `risk ${i}`, explanation: "coverage is partial" })),
  contradictions: Array.from({ length: 3 }, (_, i) => ({ statement: `contradiction ${i}`, confidence: 0.6 })),
  sectionReports: Object.fromEntries(sections.map((key) => [key, `${key}: evidence-aware text ${"x".repeat(300)}`])),
};

for (let i = 0; i < 1000; i++) evaluateBlockchainAiReport(snapshot, report);
const times: number[] = [];
for (let i = 0; i < 10000; i++) {
  const t0 = performance.now();
  evaluateBlockchainAiReport(snapshot, report);
  times.push(performance.now() - t0);
}
times.sort((a,b)=>a-b);
const avg = times.reduce((a,b)=>a+b,0)/times.length;
const p = (q:number) => times[Math.min(times.length-1, Math.floor(times.length*q))];
console.log(JSON.stringify({ iterations: times.length, avgMs: avg, medianMs: p(.5), p95Ms: p(.95), p99Ms: p(.99) }, null, 2));
