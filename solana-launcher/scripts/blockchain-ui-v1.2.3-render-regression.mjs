import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const human = read("components/trade/BlockchainHumanSummary.tsx");
const lazy = read("components/trade/LazyMountDetails.tsx");
const page = read("app/trade/analysis/page.tsx");

const checks = [
  [human.includes('/api/trade/chain-full'), "human summary uses direct chain-full endpoint"],
  [!human.includes('/api/trade/blockchain-ai'), "human summary is independent from DEV/AI snapshot endpoint"],
  [human.includes('method: "POST"') && human.includes('JSON.stringify({ mint })'), "chain-full POST contract"],
  [human.includes('liquidityUsd') && human.includes('top10Pct') && human.includes('totalHolderCount'), "core holder/liquidity fields wired"],
  [human.includes('observedTrades') && human.includes('observedSlots') && human.includes('walletProfiles'), "trade/wallet fields wired"],
  [human.includes('0 не трактуется как отсутствие торговли') && human.includes('unknown не означает safe'), "unknown-zero-safe semantics retained"],
  [lazy.includes('{open ?') && lazy.includes('onToggle'), "closed details do not mount children"],
  [(page.match(/<LazyMountDetails summary=/g) || []).length >= 3, "advanced DEV and AI blocks are lazy mounted"],
  [page.includes('<BlockchainAnalyticsDashboard mint={mint} />') && page.includes('<DevHistoryV2 mint={mint} />'), "deep deterministic analytics preserved"],
  [page.includes('<BlockchainAiReportPanel mint={mint} />'), "AI report preserved behind lazy mount"],
];

checks.forEach(([ok, label], index) => assert.ok(ok, `FAIL ${index + 1}: ${label}`));
console.log(`BLOCKCHAIN_UI_V1_2_3_RENDER_REGRESSION=PASS ${checks.length}/${checks.length}`);