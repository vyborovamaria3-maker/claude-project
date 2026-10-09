import { getTopEntities } from "../src/intelligence/analytics/entity-stats";
import { getTopAuthors } from "../src/intelligence/analytics/accounts";
import { calculateTrend } from "../src/intelligence/analytics/trends";
import { metrics } from "../src/core/metrics";

function arg(k: string): string | undefined {
  const i = process.argv.indexOf(`--${k}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}
function has(k: string) { return process.argv.includes(`--${k}`); }
function hr(t: string) { console.log("\n" + "━".repeat(72) + "\n  " + t + "\n" + "━".repeat(72)); }

async function main() {
  const hours = Number(arg("hours") ?? 24);
  const limit = Number(arg("limit") ?? 10);
  const showTrends = has("trends");

  hr(`INTELLIGENCE REPORT · ${hours}h`);

  const tokens = await getTopEntities({ type: "TOKEN", hours, limit });
  console.log("\nTOP TOKENS");
  if (tokens.length === 0) console.log("(нет данных)");
  else tokens.forEach((s) => console.log(`${s.value} ${s.mentions} mentions`));

  const hashtags = await getTopEntities({ type: "HASHTAG", hours, limit });
  console.log("\nTOP HASHTAGS");
  if (hashtags.length === 0) console.log("(нет данных)");
  else hashtags.forEach((s) => console.log(`${s.value} ${s.mentions} mentions`));

  const authors = await getTopAuthors({ hours, limit });
  console.log("\nTOP AUTHORS");
  if (authors.length === 0) console.log("(нет данных)");
  else authors.forEach((a) => console.log(`${a.handle} ${a.tweets} tweets ${a.entities} entities ${a.tokens} tokens`));

  if (showTrends) {
    console.log("\nTOP TOKEN TRENDS");
    if (tokens.length === 0) console.log("(нет данных)");
    else {
      for (const t of tokens) {
        const tr = await calculateTrend({ value: t.value, type: "TOKEN", hours });
        console.log(`${tr.value} ${tr.previous} → ${tr.current} mentions, ${tr.growthPercent}% (${tr.trend})`);
      }
    }
  }

  metrics.reportsGenerated += 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
