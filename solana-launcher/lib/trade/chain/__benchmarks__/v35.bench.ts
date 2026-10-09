import {
  computeCostBasisLedgers,
  computeHolderCohortMigration,
  computeLiquidityAdjustedFlow,
  computeOutcomeReplay,
  computeWalletClusterPersistence,
  computeWalletTemporalBehavior,
  type TemporalSignalSnapshot,
} from '../quality-v3';
import { WRAPPED_SOL_MINT, type FundingEdge, type HolderAccount, type RawTrade } from '../types';

const NOW = 2_000_000;
const trades: RawTrade[] = [];
for (let i = 0; i < 3200; i++) {
  const wallet = `W${i % 60}`;
  trades.push({
    signature: `s${i}`, timestamp: NOW - (i % 20_000), slot: 100_000 + i, trader: wallet,
    type: i % 3 === 0 ? 'sell' : 'buy', amountSol: 0.05 + (i % 20) / 100,
    amountTokens: 10 + (i % 50), priceSol: 0.001, quoteMint: WRAPPED_SOL_MINT,
    quoteAmount: 0.05 + (i % 20) / 100, quoteDecimals: 9, quoteUsdValue: (0.05 + (i % 20) / 100) * 150,
  });
}
const holders: HolderAccount[] = Array.from({ length: 60 }, (_, i) => ({ address: `W${i}`, pct: 100 / 60 }));
const ages = holders.map((row, i) => ({ address: row.address, firstSeen: NOW - (i + 1) * 10_000 }));
const funding: FundingEdge[] = Array.from({ length: 20 }, (_, i) => ({ source: `F${Math.floor(i / 4)}`, target: `W${i}`, signature: `f${i}`, lamports: 1e9, blockTime: NOW - i * 10, historyComplete: true, confidence: 0.95 }));
const history: TemporalSignalSnapshot[] = Array.from({ length: 240 }, (_, i) => ({
  schemaVersion: 1 as const, observedAt: (NOW * 1000) - (240 - i) * 5 * 60_000, priceUsd: 1 + i / 1000, liquidityUsd: 100_000 + i * 10,
  lifecycleStage: 'acceleration', signals: { demandMomentum: 50 + (i % 40), distributionRisk: 20, coordination: 30, organicGrowth: 60, smartMoney: 55, ofi15m: 0.2, holderGrowth1h: 0.05, concentrationVelocity1h: -0.01, liquidityPressure15m: 0.1 },
  holderCohorts: null,
}));

function runOnce() {
  computeWalletTemporalBehavior(trades, NOW, 21_600, false, 30);
  computeCostBasisLedgers(trades, 30);
  computeWalletClusterPersistence(trades, funding, [], NOW, 21_600);
  computeLiquidityAdjustedFlow(trades, NOW, 21_600, false, { liquidityUsd: 100_000, quotePriceUsd: 150, quoteTokenAddress: WRAPPED_SOL_MINT });
  computeHolderCohortMigration(holders, ages, NOW * 1000, history);
  computeOutcomeReplay(history);
}

for (let i = 0; i < 10; i++) runOnce();
const loops = 50;
const started = performance.now();
for (let i = 0; i < loops; i++) runOnce();
const elapsed = performance.now() - started;
const avg = elapsed / loops;
console.log(`V35_BENCH_LOOPS=${loops}`);
console.log(`V35_BENCH_TOTAL_MS=${elapsed.toFixed(3)}`);
console.log(`V35_BENCH_AVG_MS=${avg.toFixed(3)}`);
console.log(`V35_BENCH_BUDGET_MS=20`);
if (avg >= 20) throw new Error(`V3.5 benchmark budget exceeded: ${avg.toFixed(3)}ms`);


// Production-scale replay check: one persisted point/minute approaches 10k rows/week.
const replayHistory: TemporalSignalSnapshot[] = Array.from({ length: 10_000 }, (_, i) => ({
  schemaVersion: 1 as const,
  observedAt: (NOW * 1000) - (10_000 - i) * 60_000,
  priceUsd: 1 + i / 100_000,
  liquidityUsd: 100_000 + i,
  lifecycleStage: 'acceleration',
  signals: { demandMomentum: 50 + (i % 40), distributionRisk: 20, coordination: 30, organicGrowth: 60, smartMoney: 55, ofi15m: 0.2, holderGrowth1h: 0.05, concentrationVelocity1h: -0.01, liquidityPressure15m: 0.1 },
  holderCohorts: null,
}));
// Warm the production-scale path separately: a single cold JIT timing is too noisy to
// be a useful regression gate. Gate median and tail across repeated 10k replays.
for (let i = 0; i < 2; i++) computeOutcomeReplay(replayHistory);
const replaySamples: number[] = [];
for (let i = 0; i < 7; i++) {
  const replayStarted = performance.now();
  computeOutcomeReplay(replayHistory);
  replaySamples.push(performance.now() - replayStarted);
}
const replaySorted = [...replaySamples].sort((a, b) => a - b);
const replayMedian = replaySorted[Math.floor(replaySorted.length / 2)];
const replayP95 = replaySorted[replaySorted.length - 1];
console.log(`V35_REPLAY_10000_MEDIAN_MS=${replayMedian.toFixed(3)}`);
console.log(`V35_REPLAY_10000_P95_MS=${replayP95.toFixed(3)}`);
console.log(`V35_REPLAY_10000_MEDIAN_BUDGET_MS=20`);
console.log(`V35_REPLAY_10000_P95_BUDGET_MS=30`);
if (replayMedian >= 20) throw new Error(`V3.5 10k replay median budget exceeded: ${replayMedian.toFixed(3)}ms`);
if (replayP95 >= 30) throw new Error(`V3.5 10k replay tail budget exceeded: ${replayP95.toFixed(3)}ms`);
