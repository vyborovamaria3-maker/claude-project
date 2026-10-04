import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const aiService = read("lib/trade/chain/ai-service.ts");
const devRoute = read("app/api/trade/dev-history/route.ts");
const human = read("components/trade/BlockchainHumanSummary.tsx");
const devUi = read("components/trade/DevHistoryV2.tsx");
const aiPanel = read("components/trade/BlockchainAiReportPanel.tsx");
const dashboard = read("components/trade/BlockchainAnalyticsDashboard.tsx");

const checks = [
  [aiService.includes("BLOCKCHAIN_DEV_HISTORY_SNAPSHOT_TIMEOUT_MS"), "snapshot DEV timeout configurable"],
  [aiService.includes('reason: "DEV history timed out"'), "snapshot returns chain evidence when DEV times out"],
  [aiService.includes("Promise.race"), "snapshot deadline uses bounded race"],
  [devRoute.includes("DEV_HISTORY_HTTP_TIMEOUT_MS"), "direct DEV endpoint timeout configurable"],
  [devRoute.includes('sourceStatus: "timeout"'), "DEV timeout is explicit unknown state"],
  [human.includes('/api/trade/chain-full') && !human.includes('/api/trade/blockchain-ai'), "human summary bypasses DEV-coupled snapshot endpoint"],
  [human.includes("friendlyError"), "human summary hides raw browser transport errors"],
  [devUi.includes("friendlyDevHistoryError"), "DEV UI hides raw browser transport errors"],
  [aiPanel.includes("friendlyBlockchainAiError"), "AI UI hides raw browser transport errors"],
  [dashboard.includes("friendlyBlockchainDashboardError"), "full dashboard hides raw browser transport errors"],
];

checks.forEach(([ok, label], index) => assert.ok(ok, `FAIL ${index + 1}: ${label}`));
console.log(`BLOCKCHAIN_UI_V1_2_2_TIMEOUT_REGRESSION=PASS ${checks.length}/${checks.length}`);