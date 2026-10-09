import { detectSignals, saveSignals, type DetectedSignal } from "../src/intelligence/signals/detector";
import { SIGNAL_CONFIG, SIGNAL_SOURCE } from "../src/intelligence/signals/config";
import { resolveWeightedLevel } from "../src/intelligence/signals/weighted-scorer";
import { metrics } from "../src/core/metrics";

function arg(k: string): string | undefined {
  const i = process.argv.indexOf(`--${k}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}
function has(k: string) { return process.argv.includes(`--${k}`); }
function hr(t: string) { console.log("\n" + "━".repeat(72) + "\n  " + t + "\n" + "━".repeat(72)); }

function printSignal(s: DetectedSignal) {
  const m = s.metadata;
  const weightedLevel = typeof m.weightedScore === "number" ? resolveWeightedLevel(m.weightedScore) : undefined;
  console.log(`\n${s.entity}`);
  console.log(`Base Score: ${m.baseScore ?? s.score}`);
  console.log(`Level: ${s.level}`);
  console.log(`Weighted Score: ${m.weightedScore ?? "-"}`);
  if (weightedLevel) console.log(`Weighted Level: ${weightedLevel}`);
  console.log(`KOL Influence: ${m.kolInfluence ?? 0}`);
  console.log(`Priority: ${m.priority ?? "-"}`);
  if (m.kolDetected) {
    console.log(`KOLs: ${m.authors.map((h) => `@${h}`).join(", ")} (influence ${s.authorInfluence ?? "-"})`);
  }
  console.log("Factors:");
  const pad = (w: string) => w.padEnd(10);
  console.log(`  ${pad("frequency")}+${s.factors.frequency}`);
  console.log(`  ${pad("growth")}+${s.factors.growth}`);
  console.log(`  ${pad("authors")}+${s.factors.authors}`);
  console.log(`  ${pad("velocity")}+${s.factors.velocity}`);
}

async function main() {
  const hours = Number(arg("hours") ?? SIGNAL_CONFIG.windowHours);
  const limit = Number(arg("limit") ?? 20);
  const minScore = Number(arg("min-score") ?? SIGNAL_CONFIG.minScore);
  const typeRaw = (arg("type") ?? "TOKEN").toUpperCase();
  const type = typeRaw === "ALL" ? "ALL" : typeRaw;
  const showCandidates = has("candidates");

  const all = await detectSignals({
    hours,
    limit,
    type: type as "ALL",
    minScore: 0,
  });
  const signals = all.filter((s) => s.score >= minScore);
  const rejected = all.filter((s) => s.score < minScore);

  hr(`SIGNALS REPORT · ${hours}h · type=${type} · min score ${minScore}`);
  console.log(`signals: ${signals.length} / candidates: ${all.length}`);

  if (signals.length === 0) console.log("\n(сигналов нет)");
  else signals.forEach(printSignal);

  if (showCandidates && rejected.length > 0) {
    console.log("\nBELOW THRESHOLD");
    rejected.forEach((s) =>
      console.log(`${s.entity} score=${s.score} level=${s.level} ` +
        `freq=${s.factors.frequency} growth=${s.factors.growth} authors=${s.factors.authors} velocity=${s.factors.velocity}`));
  }

  if (has("save")) {
    const saved = await saveSignals(signals, { source: SIGNAL_SOURCE });
    console.log(`\nsaved to signal_history: ${saved}`);
  }

  metrics.reportsGenerated += 1;
  console.log(
    `\nmetrics: signalsCalculated=${metrics.signalsCalculated} ` +
    `signalsCreated=${metrics.signalsCreated} signalsErrors=${metrics.signalsErrors} ` +
    `weightedSignalsCalculated=${metrics.weightedSignalsCalculated} ` +
    `prioritySignalsCreated=${metrics.prioritySignalsCreated}`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
