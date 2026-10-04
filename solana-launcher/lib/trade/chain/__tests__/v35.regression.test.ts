import { describe, expect, it } from 'vitest';
import {
  buildTemporalSignalSnapshot,
  computeCostBasisLedgers,
  computeHolderCohortMigration,
  computeHolderCohortSnapshot,
  computeLiquidityAdjustedFlow,
  computeOutcomeReplay,
  computeWalletClusterPersistence,
  computeWalletCostBasisLedger,
  computeWalletTemporalBehavior,
  type TemporalSignalSnapshot,
} from '../quality-v3';
import type { CompositeScores, OrderFlowImbalance } from '../quality-v2';
import { WRAPPED_SOL_MINT, type FundingEdge, type HolderAccount, type RawTrade } from '../types';

const NOW = 2_000_000;
const NOW_MS = NOW * 1000;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function trade(overrides: Partial<RawTrade> = {}): RawTrade {
  return {
    signature: overrides.signature ?? 'sig',
    timestamp: overrides.timestamp ?? NOW,
    slot: overrides.slot ?? 100,
    trader: overrides.trader ?? 'A',
    type: overrides.type ?? 'buy',
    amountSol: overrides.amountSol ?? 1,
    amountTokens: overrides.amountTokens ?? 10,
    priceSol: overrides.priceSol ?? 0.1,
    quoteMint: overrides.quoteMint ?? WRAPPED_SOL_MINT,
    quoteAmount: overrides.quoteAmount ?? Math.abs(overrides.amountSol ?? 1),
    quoteDecimals: overrides.quoteDecimals ?? 9,
    quoteUsdValue: overrides.quoteUsdValue,
  };
}

function edge(source: string, target: string): FundingEdge {
  return { source, target, signature: `${source}-${target}`, lamports: 1e9, blockTime: NOW - 100, historyComplete: true, confidence: 0.95 };
}

function score(value: number | null) {
  return { value, confidence: { value: 1, components: { sampleSize: 1, dataCompleteness: 1, signalAgreement: 1, historicalCalibration: 0.5 }, penalties: [] }, reasons: [] };
}

function scores(): CompositeScores {
  return {
    smartMoneyScore: score(60), coordinationScoreV2: score(20), organicGrowthScore: score(70),
    distributionRiskScore: score(30), demandMomentumScore: score(80), narrativeMomentumScore: score(null),
  };
}

function flow(ofi15 = 0.5): OrderFlowImbalance {
  const metric = (value: number | null) => ({ value, coverage: 1, buyVolume: 10, sellVolume: 2, unit: 'usd' as const, quoteMint: null });
  return { ofi5m: metric(ofi15), ofi15m: metric(ofi15), ofi1h: metric(0.2), buyPressure1h: 0.8, whaleNetFlow1h: null, retailNetFlow1h: null, solCoverage1h: 0 };
}

function snapshot(at: number, price: number | null, signal = 50, liquidity = 100_000): TemporalSignalSnapshot {
  return {
    schemaVersion: 1,
    observedAt: at,
    priceUsd: price,
    liquidityUsd: liquidity,
    lifecycleStage: 'acceleration',
    signals: {
      demandMomentum: signal,
      distributionRisk: 100 - signal,
      coordination: 20,
      organicGrowth: signal,
      smartMoney: signal,
      ofi15m: (signal - 50) / 50,
      holderGrowth1h: 0.1,
      concentrationVelocity1h: -0.01,
      liquidityPressure15m: 0.1,
    },
    holderCohorts: null,
  };
}

describe('Blockchain Analytics V3.5 temporal regressions', () => {
  it('1. gates each wallet window by evidence coverage instead of activity span', () => {
    const rows = [trade({ timestamp: NOW - 300 }), trade({ timestamp: NOW - 60, type: 'sell' })];
    const out = computeWalletTemporalBehavior(rows, NOW, 3600, false)[0];
    expect(out.windows['1h'].netFlow).not.toBeNull();
    expect(out.windows['6h'].netFlow).toBeNull();
    expect(out.windows['6h'].coverage).toBeCloseTo(1 / 6, 8);
  });

  it('2. does not compute acceleration when 15m and 1h use incompatible units', () => {
    const rows = [
      trade({ timestamp: NOW - 700, quoteUsdValue: undefined, quoteMint: WRAPPED_SOL_MINT, quoteAmount: 1, amountSol: 1 }),
      trade({ timestamp: NOW - 100, quoteUsdValue: 20, quoteMint: USDC, quoteAmount: 20, amountSol: 0 }),
    ];
    const out = computeWalletTemporalBehavior(rows, NOW, 3600, false)[0];
    expect(out.flowAcceleration15mVs1h).toBeNull();
  });

  it('3. replays FIFO cost basis with simultaneous realized and unrealized PnL', () => {
    const rows = [
      trade({ signature: 'b1', type: 'buy', timestamp: NOW - 30, amountTokens: 100, quoteAmount: 10, amountSol: 10 }),
      trade({ signature: 's1', type: 'sell', timestamp: NOW - 20, amountTokens: 20, quoteAmount: 4, amountSol: 4 }),
      trade({ signature: 'b2', type: 'buy', timestamp: NOW - 10, amountTokens: 10, quoteAmount: 2, amountSol: 2 }),
    ];
    const out = computeWalletCostBasisLedger('A', rows, true, { unit: 'sol', quoteMint: WRAPPED_SOL_MINT, price: 0.2, timestamp: NOW });
    expect(out.realizedPnl).toBeCloseTo(2, 8); // 4 proceeds - 2 FIFO cost
    expect(out.openTokens).toBeCloseTo(90, 8);
    expect(out.openCostBasis).toBeCloseTo(10, 8); // 80*0.1 + 10*0.2
    expect(out.currentPrice).toBeCloseTo(0.2, 8);
    expect(out.unrealizedPnl).toBeCloseTo(8, 8);
    expect(out.totalPnl).toBeCloseTo(10, 8);
  });

  it('4. marks oversold observed inventory incomplete and never invents missing cost basis', () => {
    const out = computeWalletCostBasisLedger('A', [
      trade({ type: 'buy', amountTokens: 10, quoteAmount: 1, amountSol: 1, timestamp: NOW - 10 }),
      trade({ type: 'sell', amountTokens: 20, quoteAmount: 4, amountSol: 4, timestamp: NOW }),
    ], true, { unit: 'sol', quoteMint: WRAPPED_SOL_MINT, price: 0.2, timestamp: NOW });
    expect(out.completeFromObservedTrades).toBe(false);
    expect(out.unmatchedSellTokens).toBeCloseTo(10, 8);
    expect(out.realizedProceeds).toBeCloseTo(2, 8); // only matched half of the sell
    expect(out.matchedCost).toBeCloseTo(1, 8);
    expect(out.realizedPnl).toBeNull();
  });

  it('5. rejects mixed quote ledgers when no common USD notional exists', () => {
    const out = computeCostBasisLedgers([
      trade({ quoteMint: WRAPPED_SOL_MINT, quoteAmount: 1, amountSol: 1 }),
      trade({ quoteMint: USDC, quoteAmount: 10, amountSol: 0, timestamp: NOW + 1 }),
    ])[0];
    expect(out.available).toBe(false);
    expect(out.totalPnl).toBeNull();
  });

  it('6. permits mixed quote trades only when every row has a common USD notional', () => {
    const out = computeWalletCostBasisLedger('A', [
      trade({ type: 'buy', quoteMint: WRAPPED_SOL_MINT, quoteAmount: 1, amountSol: 1, quoteUsdValue: 100, amountTokens: 10, timestamp: NOW - 2 }),
      trade({ type: 'sell', quoteMint: USDC, quoteAmount: 120, amountSol: 0, quoteUsdValue: 120, amountTokens: 10, timestamp: NOW - 1 }),
    ], true, { unit: 'usd', quoteMint: null, price: 12, timestamp: NOW });
    expect(out.available).toBe(true);
    expect(out.unit).toBe('usd');
    expect(out.realizedPnl).toBeCloseTo(20, 8);
  });

  it('7. produces deterministic cluster identity for verified funding membership', () => {
    const a = computeWalletClusterPersistence([], [edge('F', 'A'), edge('F', 'B')], [], NOW, 3600)[0];
    const b = computeWalletClusterPersistence([], [edge('F', 'B'), edge('F', 'A')], [], NOW, 3600)[0];
    expect(a.clusterId).toBe(b.clusterId);
    expect(a.wallets.length).toBe(3);
    expect(a.verifiedFundingEdges).toBe(2);
  });

  it('8. does not create a temporal cluster from one coincident activity bucket', () => {
    const rows = [
      trade({ trader: 'A', timestamp: NOW - 100, type: 'buy' }), trade({ trader: 'A', timestamp: NOW - 90, type: 'buy' }),
      trade({ trader: 'B', timestamp: NOW - 100, type: 'buy' }), trade({ trader: 'B', timestamp: NOW - 80, type: 'buy' }),
    ];
    expect(computeWalletClusterPersistence(rows, [], [], NOW, 3600).length).toBe(0);
  });

  it('9. requires repeated same-direction coactivity before linking wallets', () => {
    const rows = [
      trade({ trader: 'A', timestamp: NOW - 100, type: 'buy' }), trade({ trader: 'A', timestamp: NOW - 90, type: 'buy' }),
      trade({ trader: 'B', timestamp: NOW - 100, type: 'buy' }), trade({ trader: 'B', timestamp: NOW - 80, type: 'buy' }),
      trade({ trader: 'A', timestamp: NOW - 1000, type: 'buy' }), trade({ trader: 'A', timestamp: NOW - 990, type: 'buy' }),
      trade({ trader: 'B', timestamp: NOW - 1000, type: 'buy' }), trade({ trader: 'B', timestamp: NOW - 980, type: 'buy' }),
    ];
    const out = computeWalletClusterPersistence(rows, [], [], NOW, 3600)[0];
    expect(out.wallets.length).toBe(2);
    expect(out.activeBuckets).toBe(2);
    expect(out.coactivityLinks).toBe(1);
  });

  it('10. computes liquidity-adjusted pressure from USD-normalized flow', () => {
    const rows = [
      trade({ type: 'buy', quoteUsdValue: 20_000, timestamp: NOW - 100 }),
      trade({ type: 'sell', quoteUsdValue: 5_000, timestamp: NOW - 50 }),
    ];
    const out = computeLiquidityAdjustedFlow(rows, NOW, 3600, false, { liquidityUsd: 100_000, quotePriceUsd: null, quoteTokenAddress: null });
    expect(out.m15.netFlowUsd).toBe(15_000);
    expect(out.m15.netFlowToLiquidity).toBeCloseTo(0.15, 8);
    expect(out.m15.signedPressure01).toBeGreaterThan(0);
  });

  it('11. refuses liquidity normalization when custom quote has no USD conversion', () => {
    const rows = [trade({ quoteMint: USDC, quoteAmount: 100, amountSol: 0, quoteUsdValue: undefined })];
    const out = computeLiquidityAdjustedFlow(rows, NOW, 3600, false, { liquidityUsd: 100_000, quotePriceUsd: null, quoteTokenAddress: USDC });
    expect(out.m15.available).toBe(false);
    expect(out.m15.netFlowUsd).toBeNull();
  });

  it('12. reports zero covered flow as measured zero rather than unknown', () => {
    const out = computeLiquidityAdjustedFlow([], NOW, 3600, false, { liquidityUsd: 100_000, quotePriceUsd: 100, quoteTokenAddress: WRAPPED_SOL_MINT });
    expect(out.m15.available).toBe(true);
    expect(out.m15.netFlowUsd).toBe(0);
  });

  it('13. classifies holder age cohorts by 24h and 7d boundaries', () => {
    const holders: HolderAccount[] = [
      { address: 'F', pct: 10 }, { address: 'E', pct: 20 }, { address: 'L', pct: 30 }, { address: 'U', pct: 40 },
    ];
    const out = computeHolderCohortSnapshot(holders, [
      { address: 'F', firstSeen: NOW - 3600 },
      { address: 'E', firstSeen: NOW - 2 * 86400 },
      { address: 'L', firstSeen: NOW - 10 * 86400 },
    ], NOW_MS);
    expect(out.cohorts.fresh_lt24h.supplyPct).toBe(10);
    expect(out.cohorts.emerging_1_7d.supplyPct).toBe(20);
    expect(out.cohorts.established_gte7d.supplyPct).toBe(30);
    expect(out.cohorts.unknown_age.supplyPct).toBe(40);
    expect(out.ageCoverageSupplyPct).toBe(60);
  });

  it('14. keeps unknown wallet ages in an explicit unknown cohort', () => {
    const out = computeHolderCohortSnapshot([{ address: 'U', pct: 100 }], [], NOW_MS);
    expect(out.cohorts.unknown_age.holderCount).toBe(1);
    expect(out.ageCoverageSupplyPct).toBe(0);
  });

  it('15. computes 1h cohort migration only from a near-enough baseline', () => {
    const holders: HolderAccount[] = [{ address: 'A', pct: 20 }, { address: 'B', pct: 80 }];
    const current = computeHolderCohortSnapshot(holders, [{ address: 'A', firstSeen: NOW - 3600 }, { address: 'B', firstSeen: NOW - 10 * 86400 }], NOW_MS);
    const past = snapshot(NOW_MS - 60 * 60_000, 1);
    past.holderCohorts = { ...current, observedAt: past.observedAt, cohorts: { ...current.cohorts, fresh_lt24h: { holderCount: 1, supplyPct: 10 } } };
    const out = computeHolderCohortMigration(holders, [{ address: 'A', firstSeen: NOW - 3600 }, { address: 'B', firstSeen: NOW - 10 * 86400 }], NOW_MS, [past]);
    expect(out.delta1h.supplyPctDelta.fresh_lt24h).toBe(10);
  });

  it('16. rejects stale cohort snapshots outside the baseline tolerance', () => {
    const holders: HolderAccount[] = [{ address: 'A', pct: 100 }];
    const stale = snapshot(NOW_MS - 2 * 60 * 60_000, 1);
    stale.holderCohorts = computeHolderCohortSnapshot(holders, [{ address: 'A', firstSeen: NOW - 3600 }], stale.observedAt);
    const out = computeHolderCohortMigration(holders, [{ address: 'A', firstSeen: NOW - 3600 }], NOW_MS, [stale]);
    expect(out.delta1h.supplyPctDelta.fresh_lt24h).toBeNull();
  });

  it('17. temporal snapshot preserves unavailable composite scores as null', () => {
    const composite = scores();
    composite.smartMoneyScore = score(null);
    const snap = buildTemporalSignalSnapshot({
      observedAt: NOW_MS, priceUsd: 1, liquidityUsd: 100_000, lifecycleStage: 'uncertain', compositeScores: composite,
      orderFlow: flow(), holderGrowth1h: null, concentrationVelocity1h: null,
      liquidityAdjustedFlow: computeLiquidityAdjustedFlow([], NOW, 3600, false, { liquidityUsd: 100_000, quotePriceUsd: 100, quoteTokenAddress: WRAPPED_SOL_MINT }),
      holderCohorts: null,
    });
    expect(snap.signals.smartMoney).toBeNull();
    expect(snap.signals.holderGrowth1h).toBeNull();
  });

  it('18. outcome replay uses the nearest future target inside horizon tolerance', () => {
    const a = snapshot(NOW_MS, 1, 60);
    const target = snapshot(NOW_MS + 6 * 60_000, 1.2, 70); // +6m accepted for 5m horizon
    const replay = computeOutcomeReplay([target, a]);
    expect(replay.horizons['5m'].observations).toBe(1);
    expect(replay.horizons['5m'].stats.demandMomentum.meanPriceReturnPct).toBeCloseTo(20, 8);
  });

  it('19. outcome replay does not use a target outside horizon tolerance', () => {
    const replay = computeOutcomeReplay([snapshot(NOW_MS, 1), snapshot(NOW_MS + 10 * 60_000, 2)]);
    expect(replay.horizons['5m'].observations).toBe(0);
  });

  it('20. backtest correlation stays null until at least five paired observations exist', () => {
    const history = [
      snapshot(NOW_MS, 1, 10), snapshot(NOW_MS + 5 * 60_000, 1.1, 20),
      snapshot(NOW_MS + 10 * 60_000, 1.2, 30), snapshot(NOW_MS + 15 * 60_000, 1.3, 40),
      snapshot(NOW_MS + 20 * 60_000, 1.4, 50),
    ];
    const replay = computeOutcomeReplay(history);
    expect(replay.horizons['5m'].stats.demandMomentum.samples).toBe(4);
    expect(replay.horizons['5m'].stats.demandMomentum.pearsonSignalPriceReturn).toBeNull();
  });

  it('21. computes correlation after five independent anchor/target pairs', () => {
    const history: TemporalSignalSnapshot[] = [];
    for (let i = 0; i < 6; i++) history.push(snapshot(NOW_MS + i * 5 * 60_000, 1 + i * i * 0.01, 10 + i * 10));
    const replay = computeOutcomeReplay(history);
    expect(replay.horizons['5m'].stats.demandMomentum.samples).toBe(5);
    expect(replay.horizons['5m'].stats.demandMomentum.pearsonSignalPriceReturn).not.toBeNull();
  });

  it('22. cost-basis ledger list ranks by observed trade count and respects wallet limit', () => {
    const rows = [
      trade({ trader: 'A', signature: 'a1' }), trade({ trader: 'A', signature: 'a2', timestamp: NOW - 1 }),
      trade({ trader: 'B', signature: 'b1' }),
    ];
    const out = computeCostBasisLedgers(rows, 1);
    expect(out.length).toBe(1);
    expect(out[0].wallet).toBe('A');
  });

  it('23. with incomplete launch history, FIFO inventory is diagnostic but authoritative PnL stays null', () => {
    const out = computeWalletCostBasisLedger('A', [
      trade({ type: 'buy', amountTokens: 10, quoteAmount: 1, amountSol: 1, timestamp: NOW - 10 }),
      trade({ type: 'sell', amountTokens: 5, quoteAmount: 1, amountSol: 1, timestamp: NOW - 5 }),
    ], false, { unit: 'sol', quoteMint: WRAPPED_SOL_MINT, price: 0.2, timestamp: NOW });
    expect(out.completeFromObservedTrades).toBe(true);
    expect(out.costBasisComplete).toBe(false);
    expect(out.realizedPnl).toBeNull();
    expect(out.unrealizedPnl).toBeNull();
  });

  it('24. merges cross-run cluster observation counts only for exact deterministic membership', () => {
    const first = computeWalletClusterPersistence([], [edge('F', 'A'), edge('F', 'B')], [], NOW, 3600)[0];
    const again = computeWalletClusterPersistence([], [edge('F', 'A'), edge('F', 'B')], [], NOW, 3600, [{
      clusterId: first.clusterId, observations: 4, firstSeenAt: NOW_MS - 10_000, lastSeenAt: NOW_MS - 1_000,
    }])[0];
    expect(again.observationCount).toBe(5);
    expect(again.persistedFirstSeenAt).toBe(NOW_MS - 10_000);
  });


  it('25. exposes that holder cohorts are wallet-age based and reports unobserved supply', () => {
    const out = computeHolderCohortSnapshot([{ address: 'A', pct: 25, holderSetComplete: false }], [{ address: 'A', firstSeen: NOW - 3600 }], NOW_MS);
    expect(out.basis).toBe('wallet_first_seen');
    expect(out.sampledSupplyPct).toBe(25);
    expect(out.unobservedSupplyPct).toBe(75);
    expect(out.holderSetComplete).toBe(false);
  });

  it('26. a closed complete FIFO position does not require a mark price for total realized PnL', () => {
    const out = computeWalletCostBasisLedger('A', [
      trade({ type: 'buy', amountTokens: 10, quoteAmount: 1, amountSol: 1, timestamp: NOW - 10 }),
      trade({ type: 'sell', amountTokens: 10, quoteAmount: 2, amountSol: 2, timestamp: NOW - 5 }),
    ], true, null);
    expect(out.openTokens).toBe(0);
    expect(out.unrealizedPnl).toBe(0);
    expect(out.realizedPnl).toBe(1);
    expect(out.totalPnl).toBe(1);
  });

  it('27. stale global mark is not used for open-position unrealized PnL', () => {
    const out = computeCostBasisLedgers([trade({ timestamp: NOW - 3600, type: 'buy', amountTokens: 10, quoteAmount: 1, amountSol: 1 })], 10, true, NOW, 900)[0];
    expect(out.markSource).toBeNull();
    expect(out.unrealizedPnl).toBeNull();
    expect(out.totalPnl).toBeNull();
  });


  it('28. dense polling does not inflate backtest samples with overlapping forward windows', () => {
    const history: TemporalSignalSnapshot[] = [];
    for (let i = 0; i <= 12; i++) history.push(snapshot(NOW_MS + i * 60_000, 1 + i * 0.01, 50 + i));
    const replay = computeOutcomeReplay(history);
    expect(replay.horizons['5m'].rawObservations).toBeGreaterThan(replay.horizons['5m'].observations);
    expect(replay.horizons['5m'].observations).toBe(2);
  });


  it('29. temporal wallet ranking ignores stale launch-only activity', () => {
    const rows: RawTrade[] = [];
    for (let i = 0; i < 20; i++) rows.push(trade({ trader: 'OLD', signature: `old${i}`, timestamp: NOW - 8 * 3600 - i }));
    rows.push(trade({ trader: 'LIVE', signature: 'live', timestamp: NOW - 60 }));
    const out = computeWalletTemporalBehavior(rows, NOW, 21_600, false, 1);
    expect(out.length).toBe(1);
    expect(out[0].wallet).toBe('LIVE');
  });

  it('30. stale launch coactivity cannot become current cluster persistence', () => {
    const rows = [
      trade({ trader: 'A', timestamp: NOW - 8 * 3600, type: 'buy' }), trade({ trader: 'A', timestamp: NOW - 8 * 3600 + 10, type: 'buy' }),
      trade({ trader: 'B', timestamp: NOW - 8 * 3600, type: 'buy' }), trade({ trader: 'B', timestamp: NOW - 8 * 3600 + 20, type: 'buy' }),
      trade({ trader: 'A', timestamp: NOW - 8 * 3600 - 1000, type: 'buy' }), trade({ trader: 'A', timestamp: NOW - 8 * 3600 - 990, type: 'buy' }),
      trade({ trader: 'B', timestamp: NOW - 8 * 3600 - 1000, type: 'buy' }), trade({ trader: 'B', timestamp: NOW - 8 * 3600 - 980, type: 'buy' }),
    ];
    expect(computeWalletClusterPersistence(rows, [], [], NOW, 3600).length).toBe(0);
  });

  it('31. future trades do not contaminate current FIFO inventory or mark', () => {
    const out = computeCostBasisLedgers([
      trade({ trader: 'A', signature: 'now-buy', type: 'buy', timestamp: NOW - 60, amountTokens: 10, quoteAmount: 1, amountSol: 1 }),
      trade({ trader: 'A', signature: 'future-sell', type: 'sell', timestamp: NOW + 3600, amountTokens: 10, quoteAmount: 100, amountSol: 100 }),
    ], 10, true, NOW, 900)[0];
    expect(out.soldTokens).toBe(0);
    expect(out.openTokens).toBe(10);
    expect(out.markTimestamp).toBe(NOW - 60);
  });

  it('32. malformed schema-v1 snapshot with missing signals does not poison replay', () => {
    const malformed = { ...snapshot(NOW_MS, 1), signals: null } as unknown as TemporalSignalSnapshot;
    const target = snapshot(NOW_MS + 5 * 60_000, 1.1);
    let threw = false;
    try { computeOutcomeReplay([malformed, target]); } catch { threw = true; }
    expect(threw).toBe(false);
    expect(computeOutcomeReplay([malformed, target]).horizons['5m'].stats.demandMomentum.samples).toBe(0);
  });

  it('33. a single recent buy is not misreported as persistent across nested horizons', () => {
    const out = computeWalletTemporalBehavior([trade({ timestamp: NOW - 60 })], NOW, 21_600, false)[0];
    expect(out.buyPersistence).toBeCloseTo(0.25, 8);
    expect(out.sellPersistence).toBe(0);
  });

  it('34. persistence direction uses token flow and does not penalize unknown quote comparability', () => {
    const rows = [
      trade({ timestamp: NOW - 60, quoteMint: WRAPPED_SOL_MINT, quoteAmount: 1, amountSol: 1, amountTokens: 10 }),
      trade({ timestamp: NOW - 600, quoteMint: USDC, quoteAmount: 20, amountSol: 0, amountTokens: 10 }),
    ];
    const out = computeWalletTemporalBehavior(rows, NOW, 21_600, false)[0];
    expect(out.windows['15m'].netFlow).toBeNull();
    expect(out.buyPersistence).toBeCloseTo(0.5, 8); // two positive disjoint bands out of four covered bands
  });

  it('35. cohort delta stays unknown when Top-N supply coverage is materially incomplete', () => {
    const holders: HolderAccount[] = [{ address: 'A', pct: 30, holderSetComplete: false }];
    const ages = [{ address: 'A', firstSeen: NOW - 3600 }];
    const current = computeHolderCohortSnapshot(holders, ages, NOW_MS);
    const past = snapshot(NOW_MS - 60 * 60_000, 1);
    past.holderCohorts = {
      ...current,
      observedAt: past.observedAt,
      cohorts: { ...current.cohorts, fresh_lt24h: { holderCount: 1, supplyPct: 10 } },
    };
    const out = computeHolderCohortMigration(holders, ages, NOW_MS, [past]);
    expect(out.delta1h.supplyPctDelta.fresh_lt24h).toBeNull();
  });

  it('36. cohort delta is allowed when both samples cover at least 95% of supply', () => {
    const holders: HolderAccount[] = [{ address: 'A', pct: 96, holderSetComplete: false }];
    const ages = [{ address: 'A', firstSeen: NOW - 3600 }];
    const current = computeHolderCohortSnapshot(holders, ages, NOW_MS);
    const past = snapshot(NOW_MS - 60 * 60_000, 1);
    past.holderCohorts = {
      ...current,
      observedAt: past.observedAt,
      cohorts: { ...current.cohorts, fresh_lt24h: { holderCount: 1, supplyPct: 90 } },
    };
    const out = computeHolderCohortMigration(holders, ages, NOW_MS, [past]);
    expect(out.delta1h.supplyPctDelta.fresh_lt24h).toBe(6);
  });

  it('37. a missing-price observation cannot block a later valid price sample during de-overlap', () => {
    const history = [
      snapshot(NOW_MS, null, 10),
      snapshot(NOW_MS + 60_000, 1, 20),
      snapshot(NOW_MS + 5 * 60_000, 1.1, 30),
      snapshot(NOW_MS + 6 * 60_000, 1.2, 40),
    ];
    const replay = computeOutcomeReplay(history);
    expect(replay.horizons['5m'].stats.demandMomentum.samples).toBe(1);
    expect(replay.horizons['5m'].stats.demandMomentum.meanPriceReturnPct).toBeCloseTo(20, 8);
  });

  it('38. malformed negative target prices/liquidity never create impossible returns below -100%', () => {
    const bad = snapshot(NOW_MS + 5 * 60_000, -1, 60, -100);
    const replay = computeOutcomeReplay([snapshot(NOW_MS, 1, 50, 100), bad]);
    expect(replay.horizons['5m'].stats.demandMomentum.samples).toBe(0);
    expect(replay.horizons['5m'].stats.demandMomentum.liquiditySamples).toBe(0);
  });

  it('39. collision-safe cluster ids distinguish memberships that collide under legacy 32-bit FNV', () => {
    const pairA = [
      'D6HpjQDtDLTE5poiXUX69EB8oxRSRpjLqiR8PAHU9tVC',
      'XS1QKLF4RQVGDWfLPiuCDGdYZxXNK47L9LsQDrXrsQbt',
    ];
    const pairB = [
      'MLdtFcuihEoebNw47gspuAXkDQXc9LugyvPNHSmYVJHa',
      'PL5NfGsGKrBNPnXWBa54fv9adiKa5QZr3v7aR8h6jUT8',
    ];
    const a = computeWalletClusterPersistence([], [], [{ wallets: pairA, classification: 'verified_bundle', startTs: NOW - 10 }], NOW, 3600)[0];
    const b = computeWalletClusterPersistence([], [], [{ wallets: pairB, classification: 'verified_bundle', startTs: NOW - 10 }], NOW, 3600)[0];
    expect(a.clusterId).not.toBe(b.clusterId);
    expect(a.clusterId.length).toBeGreaterThan('wc_00000000'.length);
  });

  it('40. exact-member legacy cluster history migrates without resetting observations', () => {
    const wallets = ['A', 'B'];
    const key = [...wallets].sort().join('|');
    let hash = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) { hash ^= key.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
    const legacyId = `wc_${hash.toString(16).padStart(8, '0')}`;
    const out = computeWalletClusterPersistence(
      [], [], [{ wallets, classification: 'verified_bundle', startTs: NOW - 10 }], NOW, 3600,
      [{ clusterId: legacyId, observations: 4, firstSeenAt: NOW_MS - 100_000, lastSeenAt: NOW_MS - 1_000, wallets }],
    )[0];
    expect(out.observationCount).toBe(5);
    expect(out.legacyClusterId).toBe(legacyId);
    expect(out.clusterId).not.toBe(legacyId);
  });

  it('41. high-confidence coordination is not mislabeled as a verified bundle source', () => {
    const out = computeWalletClusterPersistence([], [], [{ wallets: ['A', 'B'], classification: 'high_confidence_coordination', startTs: NOW - 10 }], NOW, 3600)[0];
    expect(out.sources).toContain('high_confidence_coordination');
    expect(out.sources).not.toContain('verified_bundle');
  });


  it('42. an epoch-boundary burst seconds apart is not mistaken for persistent coactivity', () => {
    const boundary = Math.floor((NOW - 100) / 900) * 900;
    const rows = [
      trade({ trader: 'A', signature: 'a1', timestamp: boundary - 3, type: 'buy' }),
      trade({ trader: 'A', signature: 'a2', timestamp: boundary - 1, type: 'buy' }),
      trade({ trader: 'B', signature: 'b1', timestamp: boundary - 2, type: 'buy' }),
      trade({ trader: 'B', signature: 'b2', timestamp: boundary - 1, type: 'buy' }),
      trade({ trader: 'A', signature: 'a3', timestamp: boundary + 1, type: 'buy' }),
      trade({ trader: 'A', signature: 'a4', timestamp: boundary + 3, type: 'buy' }),
      trade({ trader: 'B', signature: 'b3', timestamp: boundary + 2, type: 'buy' }),
      trade({ trader: 'B', signature: 'b4', timestamp: boundary + 4, type: 'buy' }),
    ];
    expect(computeWalletClusterPersistence(rows, [], [], NOW, 3600)).toEqual([]);
  });


  it('43. future persisted cluster state cannot leak into an as-of analysis', () => {
    const current = computeWalletClusterPersistence([], [edge('F', 'A'), edge('F', 'B')], [], NOW, 3600, [{
      clusterId: 'future-id',
      observations: 99,
      firstSeenAt: NOW_MS - 100_000,
      lastSeenAt: NOW_MS + 10_000,
      updatedAt: NOW_MS + 10 * 60_000,
      wallets: ['A', 'B'],
    }])[0];
    expect(current.observationCount).toBe(1);
    expect(current.persistedFirstSeenAt).toBeNull();
  });


  it('44. out-of-domain persisted signal values are excluded from calibration', () => {
    const anchor = snapshot(NOW_MS, 1, 50);
    anchor.signals.demandMomentum = 1_000_000;
    anchor.signals.ofi15m = 7;
    const replay = computeOutcomeReplay([anchor, snapshot(NOW_MS + 5 * 60_000, 1.1, 60)]);
    expect(replay.horizons['5m'].stats.demandMomentum.samples).toBe(0);
    expect(replay.horizons['5m'].stats.ofi15m.samples).toBe(0);
  });

  it('45. duplicate observedAt snapshots are deterministically deduplicated before replay', () => {
    const first = snapshot(NOW_MS, 1, 10);
    const replacement = snapshot(NOW_MS, 1, 90);
    const target = snapshot(NOW_MS + 5 * 60_000, 1.1, 50);
    const replay = computeOutcomeReplay([first, replacement, target]);
    expect(replay.horizons['5m'].rawObservations).toBe(1);
    expect(replay.horizons['5m'].stats.demandMomentum.samples).toBe(1);
  });


  it('46. zero-notional buys cannot create a free FIFO cost basis', () => {
    const out = computeWalletCostBasisLedger('A', [
      trade({ signature: 'free-buy', type: 'buy', amountTokens: 10, amountSol: 0, quoteAmount: 0, timestamp: NOW - 10 }),
      trade({ signature: 'paid-sell', type: 'sell', amountTokens: 10, amountSol: 1, quoteAmount: 1, timestamp: NOW - 5 }),
    ], true, null);
    expect(out.available).toBe(false);
    expect(out.costBasisComplete).toBe(false);
    expect(out.realizedPnl).toBeNull();
  });

  it('47. future funding and bundle evidence cannot leak into as-of clusters', () => {
    const futureEdge: FundingEdge = { source: 'F', target: 'A', signature: 'future-edge', lamports: 1e9, blockTime: NOW + 300, historyComplete: true, confidence: 0.99 };
    const futureEdge2: FundingEdge = { source: 'F', target: 'B', signature: 'future-edge-2', lamports: 1e9, blockTime: NOW + 300, historyComplete: true, confidence: 0.99 };
    const futureBundle = { wallets: ['C', 'D'], classification: 'verified_bundle' as const, startTs: NOW + 120 };
    expect(computeWalletClusterPersistence([], [futureEdge, futureEdge2], [futureBundle], NOW, 3600)).toEqual([]);
  });

  it('48. funding edges without a time anchor are not temporal cluster evidence', () => {
    const unknownTime: FundingEdge = { source: 'F', target: 'A', signature: 'unknown-time', lamports: 1e9, blockTime: null, historyComplete: true, confidence: 0.99 };
    const unknownTime2: FundingEdge = { source: 'F', target: 'B', signature: 'unknown-time-2', lamports: 1e9, blockTime: null, historyComplete: true, confidence: 0.99 };
    expect(computeWalletClusterPersistence([], [unknownTime, unknownTime2], [], NOW, 3600)).toEqual([]);
  });

  it('49. same-slot same-second FIFO ordering ambiguity prevents authoritative PnL', () => {
    const rows = [
      trade({ signature: 'a-buy', trader: 'A', type: 'buy', timestamp: NOW - 100, slot: 500, amountTokens: 10, amountSol: 1, quoteAmount: 1 }),
      trade({ signature: 'b-buy', trader: 'A', type: 'buy', timestamp: NOW - 100, slot: 500, amountTokens: 10, amountSol: 2, quoteAmount: 2 }),
      trade({ signature: 'sell', trader: 'A', type: 'sell', timestamp: NOW - 50, slot: 600, amountTokens: 10, amountSol: 3, quoteAmount: 3 }),
    ];
    const out = computeWalletCostBasisLedger('A', rows, true, null);
    expect(out.available).toBe(true);
    expect(out.orderingComplete).toBe(false);
    expect(out.costBasisComplete).toBe(false);
    expect(out.realizedPnl).toBeNull();
  });


  it('50. replay selects price and liquidity targets independently when evidence is missing', () => {
    const anchor = snapshot(NOW_MS, 1, 50, 100);
    const closest = snapshot(NOW_MS + 5 * 60_000, 1.05, 55, 110);
    closest.priceUsd = null;
    const nearbyPrice = snapshot(NOW_MS + 6 * 60_000, 1.2, 60, 120);
    nearbyPrice.liquidityUsd = null;
    const replay = computeOutcomeReplay([anchor, closest, nearbyPrice]);
    const stat = replay.horizons['5m'].stats.demandMomentum;
    expect(stat.samples).toBe(1);
    expect(stat.liquiditySamples).toBe(1);
    expect(stat.meanPriceReturnPct).toBeCloseTo(20, 8);
    expect(stat.meanLiquidityChangePct).toBeCloseTo(10, 8);
  });



  it('51. temporal coactivity is invariant to newest-first trade ordering', () => {
    const rows = [
      trade({ signature: 'a-new-1', trader: 'A', type: 'buy', timestamp: NOW - 10, slot: 1000 }),
      trade({ signature: 'b-new-1', trader: 'B', type: 'buy', timestamp: NOW - 11, slot: 999 }),
      trade({ signature: 'a-new-2', trader: 'A', type: 'buy', timestamp: NOW - 20, slot: 998 }),
      trade({ signature: 'b-new-2', trader: 'B', type: 'buy', timestamp: NOW - 21, slot: 997 }),
      trade({ signature: 'a-old-1', trader: 'A', type: 'buy', timestamp: NOW - 910, slot: 900 }),
      trade({ signature: 'b-old-1', trader: 'B', type: 'buy', timestamp: NOW - 911, slot: 899 }),
      trade({ signature: 'a-old-2', trader: 'A', type: 'buy', timestamp: NOW - 920, slot: 898 }),
      trade({ signature: 'b-old-2', trader: 'B', type: 'buy', timestamp: NOW - 921, slot: 897 }),
    ];
    const newestFirst = [...rows].sort((a, b) => b.timestamp - a.timestamp);
    const oldestFirst = [...rows].sort((a, b) => a.timestamp - b.timestamp);
    const newest = computeWalletClusterPersistence(newestFirst, [], [], NOW, 3600);
    const oldest = computeWalletClusterPersistence(oldestFirst, [], [], NOW, 3600);
    expect(newest).toEqual(oldest);
    expect(newest.length).toBe(1);
    expect(newest[0].sources).toContain('temporal_coactivity');
  });


  it('52. complete history does not fabricate long-window coverage for a young token', () => {
    const rows = [trade({ trader: 'A', type: 'buy', timestamp: NOW - 60, amountTokens: 10, amountSol: 1, quoteAmount: 1 })];
    const behavior = computeWalletTemporalBehavior(rows, NOW, 120, true, 10)[0];
    expect(behavior.windows['5m'].coverage).toBeCloseTo(120 / 300, 8);
    expect(behavior.windows['1h'].coverage).toBeCloseTo(120 / 3600, 8);
    expect(behavior.windows['1h'].netFlow).toBeNull();
    const flow = computeLiquidityAdjustedFlow(rows, NOW, 120, true, { liquidityUsd: 100_000, quotePriceUsd: 100, quoteTokenAddress: WRAPPED_SOL_MINT });
    expect(flow.m15.available).toBe(false);
    expect(flow.h1.available).toBe(false);
  });

});
