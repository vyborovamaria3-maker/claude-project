/** Orchestration for full blockchain analysis: deterministic facts + enriched quality analytics. */
import {
  buildChainGroups,
  chainVerdictFields,
  concentrationDrift,
  evaluateSafety,
  slippageLadder,
  type ChainFull,
  type MetricGroupOut,
} from './full';
import type { ChainProvider, LargestAccount } from './provider';
import { exactHolderCount } from './types';
import type { ChainVerdictFields } from './full';
import {
  analyzeChainQuality,
  analyzeChainQualityV2,
  analyzeChainQualityV3,
  type ChainQualityAnalytics,
  type ChainQualityAnalyticsV2,
  type ChainQualityAnalyticsV3,
} from './quality';

function currentHolderPoint(largest: LargestAccount[], now: number): { ts: number; holders: number; top10Pct: number } | null {
  if (largest.length === 0) return null;
  const holders = exactHolderCount(largest);
  if (holders == null) return null;
  const top10Pct = [...largest]
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 10)
    .reduce((sum, row) => sum + (Number.isFinite(row.pct) ? Math.max(0, row.pct) : 0), 0);
  return Number.isFinite(top10Pct) ? { ts: now, holders, top10Pct } : null;
}

function appendCurrentHolderPoint<T extends { ts: number; holders: number; top10Pct: number }>(
  series: T[],
  current: { ts: number; holders: number; top10Pct: number } | null,
): Array<T | { ts: number; holders: number; top10Pct: number }> {
  if (!current) return series;
  // Replace only an exact-timestamp duplicate. Keeping the previous minute-level
  // snapshot is useful for short-window diagnostics and does not fabricate history.
  return [...series.filter((row) => row.ts !== current.ts), current].sort((a, b) => a.ts - b.ts);
}

export type ChainAnalysisFull = {
  full: ChainFull;
  drift: { holdersDrift: number | null; top10Drift: number | null };
  groups: MetricGroupOut[];
  verdictFields: ChainVerdictFields;
  quality: ChainQualityAnalytics | null;
  qualityV34: ChainQualityAnalyticsV2 | null;
  qualityV35: ChainQualityAnalyticsV3 | null;
};

export async function analyzeChainFull(provider: ChainProvider, mint: string, now = Date.now()): Promise<ChainAnalysisFull> {
  // Start every independent provider branch immediately. Quality enrichment only depends
  // on mint state + holders, so it can begin as soon as those two resolve instead of
  // waiting for LP/events/dev/holder-series branches that may be slow on richer providers.
  const mintInfoP = provider.getMintInfo(mint).catch(() => null);
  const largestP = provider.getLargestAccounts(mint, 50).catch(() => []);
  const holdersP = provider.getHoldersSeries(mint, 72).catch(() => []);
  const liquidityP = provider.getLiquidity(mint).catch(() => ({ liquidityUsd: null, reserveTokens: null, vol24Usd: null }));
  const lpP = provider.getLpLock(mint).catch(() => ({ lockedPct: null, burnedPct: null, concentrationPct: null }));
  const sellOkP = provider.simulateSell(mint).catch(() => null);
  const taxP = provider.getTransferTax(mint).catch(() => null);
  const devP = provider.getDev(mint).catch(() => null);
  const clustersP = provider.getClusters(mint).catch(() => null);
  const eventsP = provider.getEvents(mint).catch(() => []);

  const qualityP: Promise<{
    v3: ChainQualityAnalytics;
    v34: ChainQualityAnalyticsV2;
    v35: ChainQualityAnalyticsV3;
    holderSeries: Array<{ ts: number; holders: number; top10Pct: number }>;
  } | null> = provider.getQualitySupplement
    ? Promise.all([mintInfoP, largestP, holdersP]).then(async ([mintInfo, largest, providerHolderSeries]) => {
        try {
          const supplement = await provider.getQualitySupplement!(mint, largest);
          const baseInput = {
            mint,
            nowMs: now,
            supply: mintInfo?.supply ?? null,
            holders: largest,
            ...supplement,
          };
          const v3 = analyzeChainQuality(baseInput);
          const persistedHolderSeries = supplement.history
            .filter((row) => typeof row.holderCount === "number" && Number.isFinite(row.holderCount) && row.holderCount >= 0 && typeof row.top10Pct === "number" && Number.isFinite(row.top10Pct))
            .map((row) => ({ ts: row.observedAt, holders: row.holderCount as number, top10Pct: row.top10Pct as number }));
          const mergedHistorical = new Map<number, { ts: number; holders: number; top10Pct: number }>();
          for (const row of [...persistedHolderSeries, ...providerHolderSeries]) mergedHistorical.set(row.ts, row);
          const currentHolders = currentHolderPoint(largest, now);
          const effectiveHolderSeries = appendCurrentHolderPoint([...mergedHistorical.values()], currentHolders);
          const holderCountSeries = effectiveHolderSeries.map((row) => ({ ts: row.ts, holders: row.holders }));
          const v34 = analyzeChainQualityV2({
            ...baseInput,
            v1Result: v3,
            holderCountSeries,
          });
          const v35 = analyzeChainQualityV3({
            ...baseInput,
            v1Result: v3,
            v2Result: v34,
            holderCountSeries,
            temporalHistory: supplement.temporalHistory,
            walletClusterHistory: supplement.walletClusterHistory,
          });
          if (provider.recordQualitySnapshot) await provider.recordQualitySnapshot(mint, v3, now);
          if (provider.recordTemporalSnapshot) await provider.recordTemporalSnapshot(mint, v35, now);
          return { v3, v34, v35, holderSeries: effectiveHolderSeries };
        } catch {
          return null;
        }
      })
    : Promise.resolve(null);

  const [mintInfo, largest, holders, liquidity, lp, sellOk, tax, dev, clusters, events, qualityBundle] = await Promise.all([
    mintInfoP, largestP, holdersP, liquidityP, lpP, sellOkP, taxP, devP, clustersP, eventsP, qualityP,
  ]);
  const quality = qualityBundle?.v3 ?? null;
  const qualityV34 = qualityBundle?.v34 ?? null;
  const qualityV35 = qualityBundle?.v35 ?? null;
  const holderSeries = qualityBundle?.holderSeries ?? appendCurrentHolderPoint(holders, currentHolderPoint(largest, now));

  const checks = evaluateSafety(
    {
      mintAuthority: mintInfo?.mintAuthority,
      freezeAuthority: mintInfo?.freezeAuthority,
      lpLockedPct: lp.lockedPct,
      lpBurnedPct: lp.burnedPct,
      honeypotSellOk: sellOk,
      transferTaxPct: tax,
      upgradeable: mintInfo ? mintInfo.upgradeable : null,
      permanentDelegate: mintInfo ? mintInfo.permanentDelegate : undefined,
      transferHookProgramId: mintInfo ? mintInfo.transferHookProgramId : undefined,
      defaultAccountState: mintInfo ? mintInfo.defaultAccountState : undefined,
      nonTransferable: mintInfo ? mintInfo.nonTransferable : undefined,
    },
    {
      mint_authority: mintInfo ? 'rpc:mint-state' : 'rpc:mint-state-unavailable',
      freeze_authority: mintInfo ? 'rpc:mint-state' : 'rpc:mint-state-unavailable',
      tax: mintInfo ? 'rpc:mint-state:token2022' : 'rpc:mint-state-unavailable',
      proxy: mintInfo ? 'rpc:mint-state' : 'rpc:mint-state-unavailable',
      permanent_delegate: mintInfo ? 'rpc:mint-state:token2022' : 'rpc:mint-state-unavailable',
      transfer_hook: mintInfo ? 'rpc:mint-state:token2022' : 'rpc:mint-state-unavailable',
      default_frozen: mintInfo ? 'rpc:mint-state:token2022' : 'rpc:mint-state-unavailable',
      non_transferable: mintInfo ? 'rpc:mint-state:token2022' : 'rpc:mint-state-unavailable',
      lp_lock: (lp.lockedPct != null || lp.burnedPct != null) ? 'indexer:lp' : 'indexer:lp-unavailable',
      honeypot: sellOk != null ? 'sell-simulation' : 'sell-simulation-unavailable',
    },
    now,
  );

  const qualityClusters = quality ? {
    bundles: quality.bundles.atomicBundleVerifiedCount,
    walletSharePct: quality.bundles.currentSupplyPct,
    sniperCount: quality.snipers.walletCount,
    washSharePct: quality.wash.walletSharePct,
    smartInflowSol: quality.smartMoney.netInflowSol,
  } : null;

  // Do not apply a generic constant-product formula to CLMM/DLMM/unknown markets.
  // Prefer the canonical PumpSwap reserve model from quality analytics; otherwise keep
  // the legacy ladder only for providers that do not expose the richer quality layer.
  const slippage = quality?.exitLiquidity.available
    ? quality.exitLiquidity.slippageForSupplyPct
    : provider.getQualitySupplement ? { pct1: null, pct5: null, pct10: null }
      : slippageLadder(liquidity.reserveTokens, mintInfo?.supply ?? null);
  const sortedEvents = [...events].sort((a, b) => a.ts - b.ts);
  const full: ChainFull = {
    mint,
    asOf: now,
    checks,
    largestAccounts: largest,
    holders: holderSeries,
    liquidity: {
      liquidityUsd: liquidity.liquidityUsd,
      volLiqRatio: liquidity.liquidityUsd && liquidity.vol24Usd != null ? liquidity.vol24Usd / liquidity.liquidityUsd : null,
      slippage,
      lpConcentrationPct: lp.concentrationPct,
    },
    dev: dev ?? {
      wallets: quality?.creator.address ? [quality.creator.address] : [],
      remainingPct: quality?.creator.currentSupplyPct ?? null,
      realizedPnlSol: null,
      cexDeposits: [],
      lastActivityTs: null,
    },
    clusters: clusters ?? qualityClusters ?? { bundles: null, walletSharePct: null, sniperCount: null, washSharePct: null, smartInflowSol: null },
    events: sortedEvents,
    quality,
    truncated: quality ? !quality.concentration.holderSetComplete : true,
    sources: (() => {
      const sources = new Set<string>();
      if (mintInfo) sources.add('rpc:mint-state');
      if (largest.length) sources.add(quality?.evidence.holders.source || 'rpc:holders');
      if (liquidity.liquidityUsd != null || liquidity.reserveTokens != null || liquidity.vol24Usd != null) sources.add('market:liquidity');
      if (lp.lockedPct != null || lp.burnedPct != null || lp.concentrationPct != null) sources.add('indexer:lp');
      if (events.length) sources.add('indexer:events');
      if (quality) {
        for (const status of Object.values(quality.evidence)) {
          if (status.available && status.source) sources.add(status.source);
        }
      }
      return [...sources];
    })(),
  };
  const drift = concentrationDrift(holderSeries);
  return { full, drift, groups: buildChainGroups(full, drift), verdictFields: chainVerdictFields(full, drift), quality, qualityV34, qualityV35 };
}
