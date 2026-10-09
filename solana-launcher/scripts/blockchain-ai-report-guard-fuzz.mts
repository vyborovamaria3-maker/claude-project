import { evaluateBlockchainAiReport, type GuardableAiReport, type GuardSnapshot } from "../lib/trade/chain/ai-report-guard.ts";

const requiredSections = [
  "current_state", "market_flow", "holders_distribution", "wallets_smart_money", "bundles_funding_coordination", "wash_anomalies", "dev_history", "temporal_backtest", "contradictions", "unknowns", "final_assessment",
];
const sectionReports = Object.fromEntries(requiredSections.map((key) => [key, `${key}: evidence-aware`])) as Record<string, string>;
const snap: GuardSnapshot = {
  headline: { contradictions: 1 },
  dataQuality: {
    chainTruncated: false,
    evidence: {
      a: { available: true, complete: true, coveragePct: 100 },
      b: { available: true, complete: false, coveragePct: 45 },
      c: { available: false, complete: false, coveragePct: 0 },
    },
    sourceTimes: { sourceSkewMs: 0 },
  },
  unknowns: ["partial funding", "wallet history unavailable"],
  compactMeta: { payloadTruncated: false },
  reportContract: { requiredSections },
};

function base(summary: string): GuardableAiReport {
  return {
    summary,
    overallConfidence: 0.6,
    finalIntelligence: {
      marketState: "Evidence is mixed.",
      manipulationAssessment: "Relations are not ownership proof.",
      bullCase: "Conditional only.",
      bearCase: "Coverage is partial.",
      unknowns: ["partial funding", "wallet history unavailable"],
      confidence: 0.6,
    },
    contradictions: [{ statement: "Flow and price diverge.", confidence: 0.7 }],
    sectionReports,
  };
}

const funding = ["Funding graph", "Funder relation", "Фандинг", "Источник средств"];
const coordination = ["Coordination", "Coactivity", "Координация", "Синхронные действия"];
const ownership = ["proves common ownership", "shows the same owner", "means wallets are controlled by the same entity", "доказывает общего владельца", "кошельки контролируются одним владельцем"];
const insider = ["confirms insider wallets", "proves insiders", "подтверждает инсайдерские кошельки", "это инсайдеры"];
const hedges = ["does not prove", "cannot establish", "may suggest but does not prove", "не доказывает", "не подтверждает", "может указывать, но не доказывает"];
const causes = ["caused the price rise", "led to the dump", "вызвал рост цены", "привёл к падению цены"];
const correlations = ["Spearman correlation", "Backtest correlation", "Корреляция Спирмена", "Бэктест"];
const signals = ["OFI", "Whale flow", "Smart money flow", "Поток покупок", "Киты"];

let bad = 0;
let badCaught = 0;
let good = 0;
let falsePositives = 0;
const failures: Array<{ i: number; expected: string; status: string; summary: string; codes: string[] }> = [];

for (let i = 0; i < 1000; i++) {
  const category = i % 10;
  let summary = "";
  let expected: "bad" | "good";
  if (category === 0) {
    summary = `${funding[i % funding.length]} ${ownership[i % ownership.length]}.`;
    expected = "bad";
  } else if (category === 1) {
    summary = `${coordination[i % coordination.length]} ${insider[i % insider.length]}.`;
    expected = "bad";
  } else if (category === 2) {
    summary = `Jito tip confirms a verified atomic bundle.`;
    expected = "bad";
  } else if (category === 3) {
    summary = `${correlations[i % correlations.length]} ${causes[i % causes.length]}.`;
    expected = "bad";
  } else if (category === 4) {
    summary = `${signals[i % signals.length]} ${causes[i % causes.length]}.`;
    expected = "bad";
  } else if (category === 5) {
    summary = i % 2 ? "The token will definitely rise." : "Токен точно вырастет.";
    expected = "bad";
  } else if (category === 6) {
    summary = `${funding[i % funding.length]} ${hedges[i % hedges.length]} common ownership.`;
    expected = "good";
  } else if (category === 7) {
    summary = `${coordination[i % coordination.length]} ${hedges[i % hedges.length]} insider control.`;
    expected = "good";
  } else if (category === 8) {
    summary = `${correlations[i % correlations.length]} is descriptive only and does not prove causality or guarantee future returns.`;
    expected = "good";
  } else {
    summary = `${funding[i % funding.length]} does not prove common ownership, but there is no proof of insider control either.`;
    expected = "good";
  }

  const result = evaluateBlockchainAiReport(snap, base(summary));
  if (expected === "bad") {
    bad += 1;
    if (result.status !== "pass") badCaught += 1;
    else failures.push({ i, expected, status: result.status, summary, codes: result.violations.map((v) => v.code) });
  } else {
    good += 1;
    if (result.status !== "pass") {
      falsePositives += 1;
      failures.push({ i, expected, status: result.status, summary, codes: result.violations.map((v) => v.code) });
    }
  }
}

const out = { total: 1000, bad, badCaught, recall: bad ? badCaught / bad : null, good, falsePositives, falsePositiveRate: good ? falsePositives / good : null, failures: failures.slice(0, 20) };
console.log(JSON.stringify(out, null, 2));
if (badCaught !== bad || falsePositives !== 0) process.exitCode = 1;
