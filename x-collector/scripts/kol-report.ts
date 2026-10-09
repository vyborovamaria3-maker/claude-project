import { detectKOLs, type DetectedKOL } from "../src/intelligence/authors/detector";
import { AUTHOR_CONFIG } from "../src/intelligence/authors/config";
import { metrics } from "../src/core/metrics";

function arg(k: string): string | undefined {
  const i = process.argv.indexOf(`--${k}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}
function has(k: string) { return process.argv.includes(`--${k}`); }
function hr(t: string) { console.log("\n" + "━".repeat(72) + "\n  " + t + "\n" + "━".repeat(72)); }
function pad(w: string) { return w.padEnd(14); }

function printKOL(kol: DetectedKOL, minScore: number) {
  const below = kol.score < AUTHOR_CONFIG.minScoreToDetect;
  console.log(`\n@${kol.handle}`);
  console.log(`Score: ${kol.score}`);
  console.log(`Level: ${kol.level}${below && minScore < AUTHOR_CONFIG.minScoreToDetect ? " (below KOL threshold)" : ""}`);
  console.log("Metrics:");
  console.log(`  ${pad("tweets")}${kol.metrics.tweets}`);
  console.log(`  ${pad("tokens")}${kol.metrics.tokens}`);
  console.log(`  ${pad("entities")}${kol.metrics.entities}`);
  console.log(`  ${pad("engagement")}${kol.metrics.avgEngagement} avg`);
  console.log("Factors:");
  console.log(`  ${pad("activity")}+${kol.factors.activity}`);
  console.log(`  ${pad("entityQuality")}+${kol.factors.entityQuality}`);
  console.log(`  ${pad("consistency")}+${kol.factors.consistency}`);
  console.log(`  ${pad("engagement")}+${kol.factors.engagement}`);
}

async function main() {
  const limit = Number(arg("limit") ?? 20);
  const hoursRaw = arg("hours");
  const hours = hoursRaw ? Number(hoursRaw) : undefined;
  const showAll = has("all");
  const minScore = Number(arg("min-score") ?? (showAll ? 0 : AUTHOR_CONFIG.minScoreToDetect));

  const kols = await detectKOLs({ hours, limit, minScore });

  hr(`KOL REPORT · ${hours ? `${hours}h` : "all time"} · min score ${minScore}`);
  console.log(`kols: ${kols.length} / authors analyzed: ${metrics.authorsAnalyzed}`);

  if (kols.length === 0) console.log("\n(KOL не найдены)");
  else kols.forEach((kol) => printKOL(kol, minScore));

  metrics.reportsGenerated += 1;
  console.log(
    `\nmetrics: authorsAnalyzed=${metrics.authorsAnalyzed} ` +
    `kolsDetected=${metrics.kolsDetected} reportsGenerated=${metrics.reportsGenerated}`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
