import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const page = readFileSync(join(root, "app/trade/analysis/page.tsx"), "utf8");
const panel = readFileSync(join(root, "components/trade/DevHistoryV2.tsx"), "utf8");
const route = readFileSync(join(root, "app/api/trade/dev-history/route.ts"), "utf8");
const helper = readFileSync(join(root, "lib/trade/dev-history.ts"), "utf8");
const server = readFileSync(join(root, "lib/trade/dev-history-server.ts"), "utf8");
const dev = readFileSync(join(root, "lib/trade/dev.ts"), "utf8");
const db = readFileSync(join(root, "lib/trade/db.ts"), "utf8");

assert(page.includes("<DevHistoryV2 mint={mint} />"), "Blockchain tab must render DEV History V2");
assert(!page.includes("Технический DEV / forensics"), "Legacy technical DEV / forensics block must stay removed");
assert(panel.includes("ATH performance distribution") && panel.includes("Creator performance trend") && panel.includes("Recurring wallet network"), "DEV History UI sections missing");
assert(panel.includes("Median lifespan") && panel.includes(">24h survival"), "Historical lifespan metrics must be surfaced when forensics evidence exists");
assert(route.includes("buildDevHistoryReport"), "DEV History API must use the shared server builder");
assert(server.includes("computeDevHistoryAnalytics") && server.includes("getDevRecurringWallets"), "Shared DEV History server builder must use pure analytics + recurring network evidence");
assert(helper.includes("raw.mint === currentMint") && helper.includes("continue;"), "Current mint must be excluded from historical profile");
assert(helper.includes("unknown ATH rows are excluded from failure denominators"), "Unknown ATH evidence semantics note missing");
assert(dev.includes("t.isMigrated = t.isMigrated || info.migrated"), "Migration evidence must be monotonic");
assert(db.includes("is_migrated    = MAX(is_migrated, excluded.is_migrated)"), "Persisted migration evidence must be monotonic");
assert(db.includes("reached_300k   = MAX(reached_300k, excluded.reached_300k)"), "Persisted 300k evidence must be monotonic");
console.log("DEV_HISTORY_V2_UI_REGRESSION=PASS 11/11");
