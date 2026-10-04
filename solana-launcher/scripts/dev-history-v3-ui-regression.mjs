import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const component = readFileSync(new URL("../components/trade/DevHistoryV2.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/trade/dev-history/route.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../lib/trade/dev-history-server.ts", import.meta.url), "utf8");
const routeLogic = `${route}\n${server}`;
const db = readFileSync(new URL("../lib/trade/db.ts", import.meta.url), "utf8");
const q3 = readFileSync(new URL("../lib/trade/chain/quality-v3.ts", import.meta.url), "utf8");
const quality = readFileSync(new URL("../lib/trade/chain/quality.ts", import.meta.url), "utf8");
const dev = readFileSync(new URL("../lib/trade/dev.ts", import.meta.url), "utf8");
const checks = [
  [component.includes("Observed launch outcome curve"), "outcome curve UI"],
  [component.includes("Post-migration replay"), "post-migration UI"],
  [component.includes('(["5m", "15m", "1h", "6h", "24h"] as const)'), "all launch horizons"],
  [component.includes("Temporal coverage") || component.includes("temporal coverage"), "coverage visible"],
  [routeLogic.includes("getNearestChainTemporalSnapshots"), "batched temporal lookup"],
  [routeLogic.includes("TEMPORAL_RETENTION_DAYS = 14"), "retention explicit"],
  [routeLogic.includes("migrationByMint"), "migration evidence wiring"],
  [db.includes("ROW_NUMBER() OVER") && db.includes("PARTITION BY targets.key"), "nearest SQL ranked"],
  [q3.includes("migrationAt?: number | null") && q3.includes("marketCapUsd?: number | null"), "temporal schema extensions"],
  [quality.includes("currentMigrationAt ?? rememberedMigrationAt"), "migration timestamp persists monotonically"],
  [!component.includes('label=">24h survival"'), "legacy heuristic survival removed from headline UI"],
  [component.includes("retentionCoverage") && component.includes("retentionLaunchAnchorCoverage"), "retention-window coverage separated from lifetime"],
  [component.includes("Confirmed migrated") && component.includes("lower bound"), "migration share labeled as lower bound"],
  [routeLogic.includes("totalSupply: null"), "legacy guessed supply not promoted to replay evidence"],
  [dev.includes("totalSupply: null") && !dev.includes("totalSupply: 1_000_000_000"), "analyzeDev no longer persists guessed 1B supply"],
  [dev.includes('pair.dexId === "pumpfun"') && dev.includes("t.createdAt == null"), "DEX migration pair cannot overwrite launch timestamp"],
  [db.includes("PARTITION BY targets.key, targets.mint"), "nearest lookup partitions by key and mint"],
  [db.includes("CHAIN_TEMPORAL_GLOBAL_PRUNE_INTERVAL_MS"), "global temporal retention pruning"],
  [db.includes("not_before_target") && routeLogic.includes("notBeforeTarget: true"), "forward horizons cannot select pre-target snapshots"],
  [dev.includes("Math.max(...validAths)") && dev.includes("Math.min(...validCreated)"), "DEV source merge keeps monotonic ATH and earliest launch time"],
  [dev.includes("mcObservedByHour") && !dev.includes("sumByHour[hour] += t.marketCapUsd ?? 0"), "unknown MC does not become zero in best-launch-hour"],
  [routeLogic.includes("Math.min(existing, migrationAt)"), "migration evidence merge keeps earliest confirmed timestamp"],
];
let pass = 0;
for (const [ok, label] of checks) { assert.ok(ok, label); pass++; console.log(`PASS ${pass}: ${label}`); }
console.log(`DEV_HISTORY_V3_UI_REGRESSION_PASS=${pass}/${checks.length}`);
