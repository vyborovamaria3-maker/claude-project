// data-tag: script.market_collector
// Standalone PumpPortal collector for market overview data.
// Run alongside dev server: npx ts-node scripts/market-collector.ts

import { startMarketCollector, getCollectorStatus } from "../lib/marketCollector";

startMarketCollector();

// Print status every 30s
setInterval(() => {
  const status = getCollectorStatus();
  console.log(
    `[status] running=${status.isRunning} ws=${status.wsConnected} ` +
    `dbEvents=${status.events} launches=${status.launches} migrations=${status.migrations} trades=${status.trades}`
  );
}, 30000);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[market-collector] Shutting down...");
  process.exit(0);
});
