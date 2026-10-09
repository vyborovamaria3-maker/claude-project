import type { OrderFlowImbalance, ScoreWithConfidence } from './quality-v2';
import { tradeQuoteAmount, tradeQuoteMint, WRAPPED_SOL_MINT } from './types';
import type { FundingEdge, HolderAccount, RawTrade } from './types';

/**
 * Blockchain Analytics V3.5 — temporal replay and outcome calibration.
 *
 * This module is deliberately pure CPU. It performs no HTTP/RPC/SQLite I/O.
 * Persistence lives in db/provider; callers supply historical temporal snapshots.
 * Evidence rules remain conservative: unknown never becomes zero/safe/neutral.
 */

const EPS = 1e-9;
const MIN_FLOW_COVERAGE = 0.95;
const VERIFIED_FUNDING_CONFIDENCE = 0.8;
const MAX_COACTIVITY_WALLETS_PER_BUCKET = 80;
const COACTIVITY_MAX_PAIR_GAP_SEC = 60;
const COACTIVITY_MIN_REPEAT_SPAN_SEC = 300;
const MIN_COHORT_DELTA_SUPPLY_COVERAGE = 95;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));
const clampSigned = (value: number): number => Math.max(-1, Math.min(1, value));

function mean(values: number[]): number | null {
  if (!values.length) return null;
  const out = values.reduce((sum, value) => sum + value, 0) / values.length;
  return finite(out) ? out : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const out = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return finite(out) ? out : null;
}

function hasVariation(values: number[]): boolean {
  if (values.length < 2) return false;
  const first = values[0];
  for (let i = 1; i < values.length; i++) if (values[i] !== first) return true;
  return false;
}

function sortedTrades(trades: RawTrade[]): RawTrade[] {
  return [...trades].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    const as = finite(a.slot) ? a.slot : Number.MAX_SAFE_INTEGER;
    const bs = finite(b.slot) ? b.slot : Number.MAX_SAFE_INTEGER;
    if (as !== bs) return as - bs;
    return a.signature.localeCompare(b.signature);
  });
}

function tradeNotionalUsd(trade: RawTrade, market: LiquidityMarketContext): number | null {
  if (finite(trade.quoteUsdValue)) return Math.abs(trade.quoteUsdValue);
  const amount = tradeQuoteAmount(trade);
  if (!finite(amount)) return null;
  const mint = tradeQuoteMint(trade);
  const quoteMatches = mint === market.quoteTokenAddress || (mint === WRAPPED_SOL_MINT && market.quoteTokenAddress === WRAPPED_SOL_MINT);
  if (!quoteMatches || !finite(market.quotePriceUsd) || !(market.quotePriceUsd > 0)) return null;
  return Math.abs(amount) * market.quotePriceUsd;
}

// ─────────────────────────────────────────────────────────────
// 1. Multi-window wallet behavior
// ─────────────────────────────────────────────────────────────

export type TemporalWindowKey = '5m' | '15m' | '1h' | '6h';

const WINDOWS_SEC: Record<TemporalWindowKey, number> = {
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '6h': 21_600,
};

export interface WalletWindowMetric {
  window: TemporalWindowKey;
  coverage: number;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  buyVolume: number | null;
  sellVolume: number | null;
  netFlow: number | null;
  unit: 'usd' | 'sol' | 'quote' | null;
  quoteMint: string | null;
  netTokenFlow: number | null;
}

export interface WalletTemporalBehavior {
  wallet: string;
  windows: Record<TemporalWindowKey, WalletWindowMetric>;
  flowAcceleration15mVs1h: number | null;
  buyPersistence: number | null;
  sellPersistence: number | null;
  activeWindowCount: number;
}

function coverageForWindow(coverageSec: number | null | undefined, windowSec: number, _historyComplete: boolean): number {
  // Exhausting the available token history proves there are no missing tx inside the
  // observed lifetime; it does not make a 2-minute-old token a fully covered 1h/6h
  // window. Temporal coverage is bounded by the actual observed span.
  if (!finite(coverageSec) || coverageSec < 0) return 0;
  return clamp(coverageSec / windowSec);
}

function comparableWalletNotionals(rows: RawTrade[]): { unit: 'usd' | 'sol' | 'quote'; quoteMint: string | null; values: number[] } | null {
  if (!rows.length) return null;
  if (rows.every((row) => finite(row.quoteUsdValue))) {
    return { unit: 'usd', quoteMint: null, values: rows.map((row) => Math.abs(row.quoteUsdValue!)) };
  }
  const mints = new Set(rows.map(tradeQuoteMint));
  if (mints.size !== 1) return null;
  const quoteMint = [...mints][0];
  if (!quoteMint || quoteMint === 'unknown') return null;
  const amounts = rows.map(tradeQuoteAmount);
  if (!amounts.every(finite)) return null;
  return {
    unit: quoteMint === WRAPPED_SOL_MINT ? 'sol' : 'quote',
    quoteMint,
    values: amounts.map((value) => Math.abs(value)),
  };
}

function walletWindow(rows: RawTrade[], nowSec: number, key: TemporalWindowKey, coverageSec: number | null | undefined, historyComplete: boolean): WalletWindowMetric {
  const windowSec = WINDOWS_SEC[key];
  const coverage = coverageForWindow(coverageSec, windowSec, historyComplete);
  const trades = rows.filter((row) => (row.type === 'buy' || row.type === 'sell') && finite(row.timestamp) && row.timestamp >= nowSec - windowSec && row.timestamp <= nowSec + 1);
  const buyCount = trades.filter((row) => row.type === 'buy').length;
  const sellCount = trades.filter((row) => row.type === 'sell').length;
  const comparable = comparableWalletNotionals(trades);
  const tokenKnown = trades.length > 0 && trades.every((row) => finite(row.amountTokens) && row.amountTokens >= 0);
  const netTokenFlow = tokenKnown
    ? trades.reduce((sum, row) => sum + (row.type === 'buy' ? Math.abs(row.amountTokens) : -Math.abs(row.amountTokens)), 0)
    : null;
  if (!comparable || coverage < MIN_FLOW_COVERAGE) {
    return {
      window: key,
      coverage,
      tradeCount: trades.length,
      buyCount,
      sellCount,
      buyVolume: null,
      sellVolume: null,
      netFlow: null,
      unit: comparable?.unit ?? null,
      quoteMint: comparable?.quoteMint ?? null,
      netTokenFlow: coverage >= MIN_FLOW_COVERAGE ? netTokenFlow : null,
    };
  }
  let buyVolume = 0;
  let sellVolume = 0;
  trades.forEach((trade, index) => {
    if (trade.type === 'buy') buyVolume += comparable.values[index];
    else sellVolume += comparable.values[index];
  });
  return {
    window: key,
    coverage,
    tradeCount: trades.length,
    buyCount,
    sellCount,
    buyVolume,
    sellVolume,
    netFlow: buyVolume - sellVolume,
    unit: comparable.unit,
    quoteMint: comparable.quoteMint,
    netTokenFlow,
  };
}

type PersistenceBand = { startSec: number; endSec: number };
const PERSISTENCE_BANDS: PersistenceBand[] = [
  { startSec: 0, endSec: 300 },
  { startSec: 300, endSec: 900 },
  { startSec: 900, endSec: 3_600 },
  { startSec: 3_600, endSec: 21_600 },
];

function directionalTokenPersistence(
  rows: RawTrade[],
  nowSec: number,
  coverageSec: number | null | undefined,
  historyComplete: boolean,
): { buy: number | null; sell: number | null } {
  const directions: number[] = [];
  for (const band of PERSISTENCE_BANDS) {
    const coverage = coverageForWindow(coverageSec, band.endSec, historyComplete);
    if (coverage < MIN_FLOW_COVERAGE) continue;
    const bandRows = rows.filter((row) => {
      if ((row.type !== 'buy' && row.type !== 'sell') || !finite(row.timestamp)) return false;
      const age = nowSec - row.timestamp;
      return age >= band.startSec - EPS && age < band.endSec;
    });
    if (!bandRows.every((row) => finite(row.amountTokens) && row.amountTokens >= 0)) continue;
    const netTokens = bandRows.reduce(
      (sum, row) => sum + (row.type === 'buy' ? Math.abs(row.amountTokens) : -Math.abs(row.amountTokens)),
      0,
    );
    directions.push(netTokens > EPS ? 1 : netTokens < -EPS ? -1 : 0);
  }
  if (!directions.length) return { buy: null, sell: null };
  return {
    buy: directions.filter((value) => value > 0).length / directions.length,
    sell: directions.filter((value) => value < 0).length / directions.length,
  };
}

export function computeWalletTemporalBehavior(
  trades: RawTrade[],
  nowSec: number,
  coverageSec: number | null | undefined,
  historyComplete = false,
  walletLimit = 30,
): WalletTemporalBehavior[] {
  const byWallet = new Map<string, RawTrade[]>();
  const maxWindowSec = WINDOWS_SEC['6h'];
  for (const trade of trades) {
    if (!trade.trader || (trade.type !== 'buy' && trade.type !== 'sell')) continue;
    // Temporal ranking must be based on the temporal horizon itself. Old launch
    // bursts must not displace wallets that are active now.
    if (!finite(trade.timestamp) || trade.timestamp < nowSec - maxWindowSec || trade.timestamp > nowSec + 1) continue;
    const rows = byWallet.get(trade.trader) ?? [];
    rows.push(trade);
    byWallet.set(trade.trader, rows);
  }
  const ranked = [...byWallet.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, walletLimit));

  return ranked.map(([wallet, rows]) => {
    const metrics = {
      '5m': walletWindow(rows, nowSec, '5m', coverageSec, historyComplete),
      '15m': walletWindow(rows, nowSec, '15m', coverageSec, historyComplete),
      '1h': walletWindow(rows, nowSec, '1h', coverageSec, historyComplete),
      '6h': walletWindow(rows, nowSec, '6h', coverageSec, historyComplete),
    } satisfies Record<TemporalWindowKey, WalletWindowMetric>;

    const m15 = metrics['15m'];
    const h1 = metrics['1h'];
    const comparable = m15.netFlow != null && h1.netFlow != null && m15.unit === h1.unit && m15.quoteMint === h1.quoteMint;
    // Compare per-minute net flow, so a 15m window is not mechanically smaller than 1h.
    const flowAcceleration15mVs1h = comparable
      ? (m15.netFlow! / 15) - (h1.netFlow! / 60)
      : null;
    const covered = Object.values(metrics).filter((metric) => metric.coverage >= MIN_FLOW_COVERAGE);
    // Persistence must use disjoint time bands. Nested 5m/15m/1h/6h windows let a
    // single recent buy appear in every horizon and falsely produce persistence=1.
    // Token flow also avoids treating unknown/mixed quote notionals as negative evidence.
    const directionalPersistence = directionalTokenPersistence(rows, nowSec, coverageSec, historyComplete);
    return {
      wallet,
      windows: metrics,
      flowAcceleration15mVs1h,
      buyPersistence: directionalPersistence.buy,
      sellPersistence: directionalPersistence.sell,
      activeWindowCount: covered.filter((metric) => metric.tradeCount > 0).length,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// 2. Cost-basis / PnL replay ledger
// ─────────────────────────────────────────────────────────────

export interface WalletCostBasisLedger {
  wallet: string;
  available: boolean;
  unit: 'usd' | 'sol' | 'quote' | null;
  quoteMint: string | null;
  boughtTokens: number | null;
  soldTokens: number | null;
  openTokens: number | null;
  costOfBuys: number | null;
  matchedCost: number | null;
  realizedProceeds: number | null;
  realizedPnl: number | null;
  realizedRoi: number | null;
  openCostBasis: number | null;
  currentPrice: number | null;
  unrealizedPnl: number | null;
  unrealizedRoi: number | null;
  totalPnl: number | null;
  unmatchedSellTokens: number;
  tradeCount: number;
  /** Whether the upstream history proves launch-to-now trade completeness. */
  historyComplete: boolean;
  /** True only when history is complete and no sell exceeds observed inventory. */
  costBasisComplete: boolean;
  completeFromObservedTrades: boolean;
  /** False when same timestamp+slot rows make FIFO execution order unknowable. */
  orderingComplete: boolean;
  markSource: 'global_latest_trade' | null;
  markTimestamp: number | null;
}

export interface LedgerMarkPrice {
  unit: 'usd' | 'sol' | 'quote';
  quoteMint: string | null;
  price: number;
  timestamp: number;
}

interface LedgerRow { trade: RawTrade; notional: number; unit: 'usd' | 'sol' | 'quote'; quoteMint: string | null }

function comparableLedgerRows(rows: RawTrade[]): LedgerRow[] | null {
  const trades = rows.filter((row) => row.type === 'buy' || row.type === 'sell');
  if (!trades.length) return null;
  if (trades.every((row) => finite(row.quoteUsdValue))) {
    return trades.map((trade) => ({ trade, notional: Math.abs(trade.quoteUsdValue!), unit: 'usd' as const, quoteMint: null }));
  }
  const mints = new Set(trades.map(tradeQuoteMint));
  if (mints.size !== 1) return null;
  const quoteMint = [...mints][0];
  if (!quoteMint || quoteMint === 'unknown') return null;
  const amounts = trades.map(tradeQuoteAmount);
  if (!amounts.every(finite)) return null;
  const unit = quoteMint === WRAPPED_SOL_MINT ? 'sol' as const : 'quote' as const;
  return trades.map((trade, index) => ({ trade, notional: Math.abs(amounts[index]), unit, quoteMint }));
}

export function deriveGlobalLedgerMark(trades: RawTrade[], nowSec: number | null = null): LedgerMarkPrice | null {
  const eligible = nowSec == null
    ? trades
    : trades.filter((trade) => finite(trade.timestamp) && trade.timestamp <= nowSec + 1);
  const rows = comparableLedgerRows(eligible);
  if (!rows?.length) return null;
  const priced = rows
    .filter((row) => finite(row.trade.amountTokens) && row.trade.amountTokens > 0 && finite(row.notional))
    .sort((a, b) =>
      b.trade.timestamp - a.trade.timestamp
      || (b.trade.slot ?? -1) - (a.trade.slot ?? -1)
      || b.trade.signature.localeCompare(a.trade.signature)
    );
  const latest = priced[0];
  if (!latest) return null;
  const price = latest.notional / latest.trade.amountTokens;
  if (!finite(price) || !(price > 0)) return null;
  return { unit: latest.unit, quoteMint: latest.quoteMint, price, timestamp: latest.trade.timestamp };
}

export function computeCostBasisLedgers(
  trades: RawTrade[],
  walletLimit = 30,
  historyComplete = false,
  nowSec: number | null = null,
  maxMarkAgeSec = 900,
): WalletCostBasisLedger[] {
  const byWallet = new Map<string, RawTrade[]>();
  const eligibleTrades = nowSec == null
    ? trades
    : trades.filter((trade) => finite(trade.timestamp) && trade.timestamp <= nowSec + 1);
  for (const trade of eligibleTrades) {
    if (!trade.trader || (trade.type !== 'buy' && trade.type !== 'sell')) continue;
    const rows = byWallet.get(trade.trader) ?? [];
    rows.push(trade);
    byWallet.set(trade.trader, rows);
  }
  const derivedMark = deriveGlobalLedgerMark(eligibleTrades, nowSec);
  const mark = derivedMark && (nowSec == null || (derivedMark.timestamp <= nowSec + 1 && nowSec - derivedMark.timestamp <= maxMarkAgeSec))
    ? derivedMark
    : null;
  return [...byWallet.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, walletLimit))
    .map(([wallet, walletTrades]) => computeWalletCostBasisLedger(wallet, walletTrades, historyComplete, mark));
}

export function computeWalletCostBasisLedger(
  wallet: string,
  walletTrades: RawTrade[],
  historyComplete = false,
  mark: LedgerMarkPrice | null = null,
): WalletCostBasisLedger {
  const comparable = comparableLedgerRows(walletTrades);
  const unavailable = (): WalletCostBasisLedger => ({
    wallet,
    available: false,
    unit: null,
    quoteMint: null,
    boughtTokens: null,
    soldTokens: null,
    openTokens: null,
    costOfBuys: null,
    matchedCost: null,
    realizedProceeds: null,
    realizedPnl: null,
    realizedRoi: null,
    openCostBasis: null,
    currentPrice: null,
    unrealizedPnl: null,
    unrealizedRoi: null,
    totalPnl: null,
    unmatchedSellTokens: 0,
    tradeCount: walletTrades.length,
    historyComplete,
    costBasisComplete: false,
    completeFromObservedTrades: false,
    orderingComplete: false,
    markSource: null,
    markTimestamp: null,
  });
  if (!comparable) return unavailable();

  const rows = [...comparable].sort((a, b) => {
    if (a.trade.timestamp !== b.trade.timestamp) return a.trade.timestamp - b.trade.timestamp;
    const slotDiff = (a.trade.slot ?? Number.MAX_SAFE_INTEGER) - (b.trade.slot ?? Number.MAX_SAFE_INTEGER);
    if (slotDiff !== 0) return slotDiff;
    return a.trade.signature.localeCompare(b.trade.signature);
  });
  if (!rows.every((row) => finite(row.trade.amountTokens) && row.trade.amountTokens > 0 && finite(row.notional) && row.notional > 0)) return unavailable();

  const lots: Array<{ tokens: number; unitCost: number }> = [];
  let boughtTokens = 0;
  let soldTokens = 0;
  let costOfBuys = 0;
  let matchedCost = 0;
  let realizedProceeds = 0;
  let unmatchedSellTokens = 0;
  const markCompatible = mark != null && mark.unit === rows[0].unit && mark.quoteMint === rows[0].quoteMint && finite(mark.price) && mark.price > 0;
  const currentPrice = markCompatible ? mark!.price : null;

  for (const row of rows) {
    const tokens = Math.abs(row.trade.amountTokens);
    const unitPrice = tokens > 0 ? row.notional / tokens : null;
    if (!finite(unitPrice)) continue;
    if (row.trade.type === 'buy') {
      boughtTokens += tokens;
      costOfBuys += row.notional;
      lots.push({ tokens, unitCost: unitPrice });
      continue;
    }
    soldTokens += tokens;
    let remaining = tokens;
    let matchedTokens = 0;
    let sellMatchedCost = 0;
    while (remaining > EPS && lots.length) {
      const lot = lots[0];
      const matched = Math.min(remaining, lot.tokens);
      sellMatchedCost += matched * lot.unitCost;
      matchedTokens += matched;
      remaining -= matched;
      lot.tokens -= matched;
      if (lot.tokens <= EPS) lots.shift();
    }
    matchedCost += sellMatchedCost;
    if (matchedTokens > 0) realizedProceeds += row.notional * (matchedTokens / tokens);
    if (remaining > EPS) unmatchedSellTokens += remaining;
  }

  const openTokens = lots.reduce((sum, lot) => sum + lot.tokens, 0);
  const openCostBasis = lots.reduce((sum, lot) => sum + lot.tokens * lot.unitCost, 0);
  const completeFromObservedTrades = unmatchedSellTokens <= EPS;
  // Helius timestamps are second-granularity and RawTrade does not carry a transaction
  // index. Multiple rows sharing timestamp+slot therefore have an unknowable FIFO order.
  // Keep deterministic observed math, but never promote it to authoritative PnL.
  const orderingComplete = !rows.some((row, index) => {
    if (index === 0) return false;
    const previous = rows[index - 1];
    return row.trade.timestamp === previous.trade.timestamp
      && (row.trade.slot ?? null) === (previous.trade.slot ?? null);
  });
  const costBasisComplete = historyComplete && completeFromObservedTrades && orderingComplete;
  const observedRealizedPnl = realizedProceeds - matchedCost;
  const realizedPnl = costBasisComplete ? observedRealizedPnl : null;
  const realizedRoi = costBasisComplete && matchedCost > EPS ? observedRealizedPnl / matchedCost : null;
  const observedUnrealizedPnl = openTokens <= EPS ? 0 : currentPrice != null ? openTokens * currentPrice - openCostBasis : null;
  const unrealizedPnl = costBasisComplete ? observedUnrealizedPnl : null;
  const unrealizedRoi = costBasisComplete && openCostBasis > EPS && observedUnrealizedPnl != null ? observedUnrealizedPnl / openCostBasis : null;
  const totalPnl = costBasisComplete && unrealizedPnl != null && realizedPnl != null ? realizedPnl + unrealizedPnl : null;

  return {
    wallet,
    available: true,
    unit: rows[0].unit,
    quoteMint: rows[0].quoteMint,
    boughtTokens,
    soldTokens,
    openTokens,
    costOfBuys,
    matchedCost,
    realizedProceeds,
    realizedPnl,
    realizedRoi,
    openCostBasis,
    currentPrice,
    unrealizedPnl,
    unrealizedRoi,
    totalPnl,
    unmatchedSellTokens,
    tradeCount: rows.length,
    historyComplete,
    costBasisComplete,
    completeFromObservedTrades,
    orderingComplete,
    markSource: markCompatible ? 'global_latest_trade' : null,
    markTimestamp: markCompatible ? mark!.timestamp : null,
  };
}

// ─────────────────────────────────────────────────────────────
// 3. Persistent wallet clusters (deterministic IDs + time buckets)
// ─────────────────────────────────────────────────────────────

export interface TemporalBundleGroup {
  wallets: string[];
  classification: 'verified_bundle' | 'high_confidence_coordination' | 'coordinated_buy_cluster';
  startTs: number;
}

export interface PersistedClusterHistory {
  clusterId: string;
  observations: number;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  /** Persistence write timestamp; future rows are excluded from as-of analysis. */
  updatedAt?: number | null;
  /** Exact members allow collision-safe migration from the legacy 32-bit id. */
  wallets?: string[];
}

export interface WalletClusterPersistence {
  clusterId: string;
  /** Legacy id to retire after a collision-safe id migration. */
  legacyClusterId?: string | null;
  wallets: string[];
  sources: Array<'verified_funding' | 'verified_bundle' | 'high_confidence_coordination' | 'temporal_coactivity'>;
  verifiedFundingEdges: number;
  bundleLinks: number;
  coactivityLinks: number;
  firstSeenTs: number | null;
  lastSeenTs: number | null;
  activeBuckets: number;
  persistence01: number | null;
  observationCount: number;
  persistedFirstSeenAt: number | null;
  persistedLastSeenAt: number | null;
}

function canonicalMembers(wallets: string[]): string {
  return [...new Set(wallets.filter(Boolean))].sort().join('|');
}

function legacyStableClusterId32(wallets: string[]): string {
  const key = canonicalMembers(wallets);
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `wc_${hash.toString(16).padStart(8, '0')}`;
}

function stableClusterId(wallets: string[]): string {
  // 64-bit FNV-1a. The previous 32-bit id has practical birthday collisions once
  // many exact-membership clusters are persisted. Keep the legacy id only for migration.
  const key = canonicalMembers(wallets);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < key.length; i++) {
    hash ^= BigInt(key.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return `wc_${hash.toString(16).padStart(16, '0')}`;
}

class UnionFind {
  private parent = new Map<string, string>();
  add(x: string): void { if (x && !this.parent.has(x)) this.parent.set(x, x); }
  find(x: string): string {
    this.add(x);
    const p = this.parent.get(x)!;
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string): void {
    if (!a || !b || a === b) return;
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
  groups(): string[][] {
    const out = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      const rows = out.get(root) ?? [];
      rows.push(key);
      out.set(root, rows);
    }
    return [...out.values()].map((rows) => rows.sort());
  }
}

interface PairEvidence { buckets: Set<number>; first: number; last: number; count: number }
interface WalletBucketActivity { buys: number[]; sells: number[] }

function pairKey(a: string, b: string): string { return a < b ? `${a}|${b}` : `${b}|${a}`; }

function closestActivityTimestamp(a: number[], b: number[]): number | null {
  if (!a.length || !b.length) return null;
  let i = 0;
  let j = 0;
  let bestGap = Number.POSITIVE_INFINITY;
  let bestTs: number | null = null;
  while (i < a.length && j < b.length) {
    const gap = Math.abs(a[i] - b[j]);
    if (gap < bestGap) {
      bestGap = gap;
      bestTs = Math.round((a[i] + b[j]) / 2);
    }
    if (a[i] <= b[j]) i++;
    else j++;
  }
  return bestGap <= COACTIVITY_MAX_PAIR_GAP_SEC ? bestTs : null;
}

function temporalCoactivityPairs(trades: RawTrade[], bucketSec = 900): Map<string, PairEvidence> {
  const buckets = new Map<number, Map<string, WalletBucketActivity>>();
  for (const trade of trades) {
    if (!trade.trader || (trade.type !== 'buy' && trade.type !== 'sell') || !finite(trade.timestamp)) continue;
    const bucket = Math.floor(trade.timestamp / bucketSec);
    const byWallet = buckets.get(bucket) ?? new Map<string, WalletBucketActivity>();
    const row = byWallet.get(trade.trader) ?? { buys: [], sells: [] };
    if (trade.type === 'buy') row.buys.push(trade.timestamp);
    else row.sells.push(trade.timestamp);
    byWallet.set(trade.trader, row);
    buckets.set(bucket, byWallet);
  }
  // The closest-pair two-pointer scan below requires ascending timestamps.
  // Upstream history may be newest-first, so normalize once per wallet/bucket.
  for (const wallets of buckets.values()) {
    for (const activity of wallets.values()) {
      activity.buys.sort((a, b) => a - b);
      activity.sells.sort((a, b) => a - b);
    }
  }
  const pairs = new Map<string, PairEvidence>();
  for (const [bucket, wallets] of buckets) {
    const active = [...wallets.entries()]
      .filter(([, activity]) => activity.buys.length + activity.sells.length >= 2)
      .sort((a, b) => (b[1].buys.length + b[1].sells.length) - (a[1].buys.length + a[1].sells.length) || a[0].localeCompare(b[0]))
      .slice(0, MAX_COACTIVITY_WALLETS_PER_BUCKET)
      .map(([wallet]) => wallet)
      .sort();
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = wallets.get(active[i])!;
        const b = wallets.get(active[j])!;
        const aBuys = a.buys.length;
        const aSells = a.sells.length;
        const bBuys = b.buys.length;
        const bSells = b.sells.length;
        const bothBuy = aBuys > aSells && bBuys > bSells;
        const bothSell = aSells > aBuys && bSells > bBuys;
        if (!bothBuy && !bothSell) continue;
        const ts = closestActivityTimestamp(bothBuy ? a.buys : a.sells, bothBuy ? b.buys : b.sells);
        if (ts == null) continue;
        const key = pairKey(active[i], active[j]);
        const evidence = pairs.get(key) ?? { buckets: new Set<number>(), first: ts, last: ts, count: 0 };
        evidence.buckets.add(bucket);
        evidence.first = Math.min(evidence.first, ts);
        evidence.last = Math.max(evidence.last, ts);
        evidence.count++;
        pairs.set(key, evidence);
      }
    }
  }
  return pairs;
}

export function computeWalletClusterPersistence(
  trades: RawTrade[],
  fundingEdges: FundingEdge[],
  bundles: TemporalBundleGroup[],
  nowSec: number,
  coverageSec: number | null | undefined,
  persistedHistory: PersistedClusterHistory[] = [],
): WalletClusterPersistence[] {
  const asOfMs = nowSec * 1000 + 1_000;
  const asOfPersistedHistory = persistedHistory.filter((row) => !finite(row.updatedAt) || row.updatedAt! <= asOfMs);
  const persistedById = new Map(asOfPersistedHistory.map((row) => [row.clusterId, row] as const));
  const persistedByMembers = new Map(
    asOfPersistedHistory
      .filter((row) => Array.isArray(row.wallets) && row.wallets.length > 0)
      .map((row) => [canonicalMembers(row.wallets!), row] as const),
  );
  const uf = new UnionFind();
  // Temporal/as-of clustering must never use evidence that belongs to the future.
  // Missing funding block time is also excluded here: without a timestamp we cannot
  // prove that the edge existed at the requested as-of time.
  const verifiedFunding = fundingEdges.filter((edge) =>
    edge.historyComplete
    && finite(edge.confidence)
    && edge.confidence >= VERIFIED_FUNDING_CONFIDENCE
    && finite(edge.blockTime)
    && edge.blockTime! > 0
    && edge.blockTime! <= nowSec + 1
  );
  const eligibleBundles = bundles.filter((row) =>
    row.classification !== 'coordinated_buy_cluster'
    && finite(row.startTs)
    && row.startTs <= nowSec + 1
  );
  for (const edge of verifiedFunding) {
    uf.add(edge.source); uf.add(edge.target); uf.union(edge.source, edge.target);
  }
  for (const bundle of eligibleBundles) {
    const wallets = [...new Set(bundle.wallets.filter(Boolean))];
    wallets.forEach((wallet) => uf.add(wallet));
    for (let i = 1; i < wallets.length; i++) uf.union(wallets[0], wallets[i]);
  }
  // Coactivity is a temporal signal. Only use the currently evidenced recent
  // window; launch trades or stale cached rows must not manufacture present-day
  // persistence. Unknown coverage means coactivity evidence is unavailable.
  const coactivityWindowSec = finite(coverageSec) && coverageSec > 0
    ? Math.min(coverageSec, WINDOWS_SEC['6h'])
    : 0;
  const coactivityTrades = coactivityWindowSec > 0
    ? trades.filter((trade) => finite(trade.timestamp) && trade.timestamp >= nowSec - coactivityWindowSec && trade.timestamp <= nowSec + 1)
    : [];
  const coactivity = temporalCoactivityPairs(coactivityTrades);
  for (const [key, evidence] of coactivity) {
    if (evidence.buckets.size < 2 || evidence.last - evidence.first < COACTIVITY_MIN_REPEAT_SPAN_SEC) continue;
    const [a, b] = key.split('|');
    uf.add(a); uf.add(b); uf.union(a, b);
  }

  return uf.groups()
    .filter((wallets) => wallets.length >= 2)
    .map((wallets) => {
      const memberSet = new Set(wallets);
      const funding = verifiedFunding.filter((edge) => memberSet.has(edge.source) && memberSet.has(edge.target));
      const bundleRows = eligibleBundles.filter((bundle) => bundle.wallets.filter((wallet) => memberSet.has(wallet)).length >= 2);
      const coactivityRows = [...coactivity.entries()].filter(([key, evidence]) => {
        const [a, b] = key.split('|');
        return memberSet.has(a) && memberSet.has(b) && evidence.buckets.size >= 2 && evidence.last - evidence.first >= COACTIVITY_MIN_REPEAT_SPAN_SEC;
      });
      const activeBuckets = new Set<number>();
      let firstSeenTs: number | null = null;
      let lastSeenTs: number | null = null;
      for (const [, evidence] of coactivityRows) {
        evidence.buckets.forEach((bucket) => activeBuckets.add(bucket));
        firstSeenTs = firstSeenTs == null ? evidence.first : Math.min(firstSeenTs, evidence.first);
        lastSeenTs = lastSeenTs == null ? evidence.last : Math.max(lastSeenTs, evidence.last);
      }
      for (const bundle of bundleRows) {
        if (finite(bundle.startTs)) {
          firstSeenTs = firstSeenTs == null ? bundle.startTs : Math.min(firstSeenTs, bundle.startTs);
          lastSeenTs = lastSeenTs == null ? bundle.startTs : Math.max(lastSeenTs, bundle.startTs);
        }
      }
      for (const edge of funding) {
        if (finite(edge.blockTime) && edge.blockTime! > 0) {
          firstSeenTs = firstSeenTs == null ? edge.blockTime! : Math.min(firstSeenTs, edge.blockTime!);
          lastSeenTs = lastSeenTs == null ? edge.blockTime! : Math.max(lastSeenTs, edge.blockTime!);
        }
      }
      const sources: WalletClusterPersistence['sources'] = [];
      if (funding.length) sources.push('verified_funding');
      if (bundleRows.some((bundle) => bundle.classification === 'verified_bundle')) sources.push('verified_bundle');
      if (bundleRows.some((bundle) => bundle.classification === 'high_confidence_coordination')) sources.push('high_confidence_coordination');
      if (coactivityRows.length) sources.push('temporal_coactivity');
      const possibleBuckets = coactivityWindowSec > 0
        ? Math.max(1, Math.floor(nowSec / 900) - Math.floor((nowSec - coactivityWindowSec) / 900) + 1)
        : null;
      const persistence01 = possibleBuckets != null && activeBuckets.size > 0
        ? clamp(activeBuckets.size / possibleBuckets)
        : null;
      const clusterId = stableClusterId(wallets);
      const legacyClusterId = legacyStableClusterId32(wallets);
      const memberKey = canonicalMembers(wallets);
      const legacyCandidate = persistedById.get(legacyClusterId);
      const persisted = persistedById.get(clusterId)
        ?? persistedByMembers.get(memberKey)
        ?? (legacyCandidate && Array.isArray(legacyCandidate.wallets) && canonicalMembers(legacyCandidate.wallets) === memberKey ? legacyCandidate : undefined);
      return {
        clusterId,
        legacyClusterId: persisted && persisted.clusterId !== clusterId ? persisted.clusterId : null,
        wallets,
        sources,
        verifiedFundingEdges: funding.length,
        bundleLinks: bundleRows.length,
        coactivityLinks: coactivityRows.length,
        firstSeenTs,
        lastSeenTs,
        activeBuckets: activeBuckets.size,
        persistence01,
        observationCount: Math.max(1, (persisted?.observations ?? 0) + 1),
        persistedFirstSeenAt: persisted?.firstSeenAt ?? null,
        persistedLastSeenAt: persisted?.lastSeenAt ?? null,
      };
    })
    .sort((a, b) => b.wallets.length - a.wallets.length || a.clusterId.localeCompare(b.clusterId));
}

// ─────────────────────────────────────────────────────────────
// 4. Liquidity-adjusted order flow
// ─────────────────────────────────────────────────────────────

export interface LiquidityMarketContext {
  liquidityUsd: number | null;
  quotePriceUsd: number | null;
  quoteTokenAddress: string | null;
}

export interface LiquidityAdjustedFlowMetric {
  available: boolean;
  coverage: number;
  netFlowUsd: number | null;
  grossFlowUsd: number | null;
  netFlowToLiquidity: number | null;
  grossTurnoverToLiquidity: number | null;
  signedPressure01: number | null;
}

export interface LiquidityAdjustedFlow {
  m15: LiquidityAdjustedFlowMetric;
  h1: LiquidityAdjustedFlowMetric;
}

function liquidityFlowWindow(
  trades: RawTrade[],
  nowSec: number,
  windowSec: number,
  coverageSec: number | null | undefined,
  historyComplete: boolean,
  market: LiquidityMarketContext,
): LiquidityAdjustedFlowMetric {
  const coverage = coverageForWindow(coverageSec, windowSec, historyComplete);
  if (coverage < MIN_FLOW_COVERAGE || !finite(market.liquidityUsd) || !(market.liquidityUsd > 0)) {
    return { available: false, coverage, netFlowUsd: null, grossFlowUsd: null, netFlowToLiquidity: null, grossTurnoverToLiquidity: null, signedPressure01: null };
  }
  const rows = trades.filter((trade) => (trade.type === 'buy' || trade.type === 'sell') && finite(trade.timestamp) && trade.timestamp >= nowSec - windowSec && trade.timestamp <= nowSec + 1);
  if (!rows.length) return { available: true, coverage, netFlowUsd: 0, grossFlowUsd: 0, netFlowToLiquidity: 0, grossTurnoverToLiquidity: 0, signedPressure01: 0 };
  const notionals = rows.map((trade) => tradeNotionalUsd(trade, market));
  if (!notionals.every(finite)) {
    return { available: false, coverage, netFlowUsd: null, grossFlowUsd: null, netFlowToLiquidity: null, grossTurnoverToLiquidity: null, signedPressure01: null };
  }
  let net = 0;
  let gross = 0;
  rows.forEach((trade, index) => {
    const value = notionals[index];
    gross += value;
    net += trade.type === 'buy' ? value : -value;
  });
  const netFlowToLiquidity = net / market.liquidityUsd;
  const grossTurnoverToLiquidity = gross / market.liquidityUsd;
  // tanh keeps extreme memecoin flow bounded while retaining sign and monotonicity.
  const signedPressure01 = Math.tanh(netFlowToLiquidity);
  return {
    available: true,
    coverage,
    netFlowUsd: net,
    grossFlowUsd: gross,
    netFlowToLiquidity,
    grossTurnoverToLiquidity,
    signedPressure01: clampSigned(signedPressure01),
  };
}

export function computeLiquidityAdjustedFlow(
  trades: RawTrade[],
  nowSec: number,
  coverageSec: number | null | undefined,
  historyComplete: boolean,
  market: LiquidityMarketContext,
): LiquidityAdjustedFlow {
  return {
    m15: liquidityFlowWindow(trades, nowSec, 900, coverageSec, historyComplete, market),
    h1: liquidityFlowWindow(trades, nowSec, 3_600, coverageSec, historyComplete, market),
  };
}

// ─────────────────────────────────────────────────────────────
// 5. Holder cohort migration
// ─────────────────────────────────────────────────────────────

export type HolderCohortKey = 'fresh_lt24h' | 'emerging_1_7d' | 'established_gte7d' | 'unknown_age';

export interface HolderCohortSnapshot {
  observedAt: number;
  /** Cohorts are wallet-age cohorts, not token-acquisition cohorts. */
  basis: 'wallet_first_seen';
  cohorts: Record<HolderCohortKey, { holderCount: number; supplyPct: number }>;
  sampledSupplyPct: number;
  unobservedSupplyPct: number | null;
  holderSetComplete: boolean;
  ageCoverageSupplyPct: number;
}

export interface HolderCohortDelta {
  baselineAgeMs: number | null;
  supplyPctDelta: Record<HolderCohortKey, number | null>;
}

export interface HolderCohortMigration {
  current: HolderCohortSnapshot;
  delta1h: HolderCohortDelta;
  delta6h: HolderCohortDelta;
}

export interface WalletAgeRow { address: string; firstSeen: number | null }

function cohortForAgeHours(ageHours: number | null): HolderCohortKey {
  if (ageHours == null || !finite(ageHours) || ageHours < 0) return 'unknown_age';
  if (ageHours < 24) return 'fresh_lt24h';
  if (ageHours < 24 * 7) return 'emerging_1_7d';
  return 'established_gte7d';
}

function emptyCohorts(): Record<HolderCohortKey, { holderCount: number; supplyPct: number }> {
  return {
    fresh_lt24h: { holderCount: 0, supplyPct: 0 },
    emerging_1_7d: { holderCount: 0, supplyPct: 0 },
    established_gte7d: { holderCount: 0, supplyPct: 0 },
    unknown_age: { holderCount: 0, supplyPct: 0 },
  };
}

export function computeHolderCohortSnapshot(holders: HolderAccount[], walletAges: WalletAgeRow[], nowMs: number): HolderCohortSnapshot {
  const ageByWallet = new Map(walletAges.map((row) => [row.address, row.firstSeen] as const));
  const cohorts = emptyCohorts();
  let knownSupply = 0;
  let sampledSupply = 0;
  for (const holder of holders) {
    const pct = finite(holder.pct) ? Math.max(0, holder.pct) : 0;
    sampledSupply += pct;
    const firstSeen = ageByWallet.get(holder.address) ?? null;
    const ageHours = finite(firstSeen) && firstSeen! > 0 ? (nowMs / 1000 - firstSeen!) / 3600 : null;
    const cohort = cohortForAgeHours(ageHours);
    cohorts[cohort].holderCount++;
    cohorts[cohort].supplyPct += pct;
    if (cohort !== 'unknown_age') knownSupply += pct;
  }
  const holderSetComplete = holders.length > 0 && holders.every((holder) => holder.holderSetComplete === true);
  const sampledSupplyPct = Math.min(100, sampledSupply);
  return {
    observedAt: nowMs,
    basis: 'wallet_first_seen',
    cohorts,
    sampledSupplyPct,
    unobservedSupplyPct: holderSetComplete ? 0 : Math.max(0, 100 - sampledSupplyPct),
    holderSetComplete,
    ageCoverageSupplyPct: Math.min(100, knownSupply),
  };
}

function nearestCohortBaseline(history: TemporalSignalSnapshot[], targetMs: number, toleranceMs: number): TemporalSignalSnapshot | null {
  let best: TemporalSignalSnapshot | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of history) {
    if (!row.holderCohorts) continue;
    const distance = Math.abs(row.observedAt - targetMs);
    if (distance <= toleranceMs && distance < bestDistance) {
      best = row;
      bestDistance = distance;
    }
  }
  return best;
}

function cohortDelta(current: HolderCohortSnapshot, baseline: TemporalSignalSnapshot | null): HolderCohortDelta {
  const keys: HolderCohortKey[] = ['fresh_lt24h', 'emerging_1_7d', 'established_gte7d', 'unknown_age'];
  const out = {} as Record<HolderCohortKey, number | null>;
  const previousSnapshot = baseline?.holderCohorts ?? null;
  const currentComparable = current.holderSetComplete || current.sampledSupplyPct >= MIN_COHORT_DELTA_SUPPLY_COVERAGE;
  const previousComparable = previousSnapshot != null && (
    previousSnapshot.holderSetComplete === true
    || (finite(previousSnapshot.sampledSupplyPct) && previousSnapshot.sampledSupplyPct >= MIN_COHORT_DELTA_SUPPLY_COVERAGE)
  );
  for (const key of keys) {
    const previous = previousSnapshot?.cohorts?.[key]?.supplyPct;
    out[key] = currentComparable && previousComparable && finite(previous)
      ? current.cohorts[key].supplyPct - previous
      : null;
  }
  return { baselineAgeMs: baseline ? current.observedAt - baseline.observedAt : null, supplyPctDelta: out };
}

export function computeHolderCohortMigration(
  holders: HolderAccount[],
  walletAges: WalletAgeRow[],
  nowMs: number,
  history: TemporalSignalSnapshot[],
): HolderCohortMigration {
  const current = computeHolderCohortSnapshot(holders, walletAges, nowMs);
  const oneHour = nearestCohortBaseline(history, nowMs - 3_600_000, 20 * 60_000);
  const sixHour = nearestCohortBaseline(history, nowMs - 6 * 3_600_000, 60 * 60_000);
  return { current, delta1h: cohortDelta(current, oneHour), delta6h: cohortDelta(current, sixHour) };
}

// ─────────────────────────────────────────────────────────────
// 6. Temporal snapshots + outcome replay/backtest
// ─────────────────────────────────────────────────────────────

export interface TemporalSignalValues {
  demandMomentum: number | null;
  distributionRisk: number | null;
  coordination: number | null;
  organicGrowth: number | null;
  smartMoney: number | null;
  ofi15m: number | null;
  holderGrowth1h: number | null;
  concentrationVelocity1h: number | null;
  liquidityPressure15m: number | null;
}

export interface TemporalSignalSnapshot {
  schemaVersion: 1;
  observedAt: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  /** Optional derived market cap (price × verified/indexed supply) for future DEV replay. */
  marketCapUsd?: number | null;
  /** Canonical migration/pool creation timestamp in unix milliseconds when proven. */
  migrationAt?: number | null;
  lifecycleStage: string | null;
  signals: TemporalSignalValues;
  holderCohorts: HolderCohortSnapshot | null;
}

export interface TemporalSnapshotBuildInput {
  observedAt: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  /** Optional derived market cap (price × verified/indexed supply) for future DEV replay. */
  marketCapUsd?: number | null;
  /** Canonical migration/pool creation timestamp in unix milliseconds when proven. */
  migrationAt?: number | null;
  lifecycleStage: string | null;
  compositeScores: {
    demandMomentumScore: ScoreWithConfidence;
    distributionRiskScore: ScoreWithConfidence;
    coordinationScoreV2: ScoreWithConfidence;
    organicGrowthScore: ScoreWithConfidence;
    smartMoneyScore: ScoreWithConfidence;
  };
  orderFlow: OrderFlowImbalance;
  holderGrowth1h: number | null;
  concentrationVelocity1h: number | null;
  liquidityAdjustedFlow: LiquidityAdjustedFlow;
  holderCohorts: HolderCohortSnapshot | null;
}

function scoreValue(score: ScoreWithConfidence): number | null {
  return finite(score.value) ? score.value : null;
}

export function buildTemporalSignalSnapshot(input: TemporalSnapshotBuildInput): TemporalSignalSnapshot {
  return {
    schemaVersion: 1,
    observedAt: input.observedAt,
    priceUsd: finite(input.priceUsd) && input.priceUsd! > 0 ? input.priceUsd : null,
    liquidityUsd: finite(input.liquidityUsd) && input.liquidityUsd! >= 0 ? input.liquidityUsd : null,
    marketCapUsd: finite(input.marketCapUsd) && input.marketCapUsd! > 0 ? input.marketCapUsd : null,
    migrationAt: finite(input.migrationAt) && input.migrationAt! > 0
      ? (input.migrationAt! > 10_000_000_000 ? input.migrationAt! : input.migrationAt! * 1000)
      : null,
    lifecycleStage: input.lifecycleStage || null,
    signals: {
      demandMomentum: scoreValue(input.compositeScores.demandMomentumScore),
      distributionRisk: scoreValue(input.compositeScores.distributionRiskScore),
      coordination: scoreValue(input.compositeScores.coordinationScoreV2),
      organicGrowth: scoreValue(input.compositeScores.organicGrowthScore),
      smartMoney: scoreValue(input.compositeScores.smartMoneyScore),
      ofi15m: finite(input.orderFlow.ofi15m.value) ? input.orderFlow.ofi15m.value : null,
      holderGrowth1h: finite(input.holderGrowth1h) ? input.holderGrowth1h : null,
      concentrationVelocity1h: finite(input.concentrationVelocity1h) ? input.concentrationVelocity1h : null,
      liquidityPressure15m: finite(input.liquidityAdjustedFlow.m15.signedPressure01) ? input.liquidityAdjustedFlow.m15.signedPressure01 : null,
    },
    holderCohorts: input.holderCohorts,
  };
}

export type OutcomeHorizon = '5m' | '15m' | '1h' | '6h';
const OUTCOME_HORIZONS: Record<OutcomeHorizon, { ms: number; toleranceMs: number }> = {
  '5m': { ms: 5 * 60_000, toleranceMs: 2 * 60_000 },
  '15m': { ms: 15 * 60_000, toleranceMs: 5 * 60_000 },
  '1h': { ms: 60 * 60_000, toleranceMs: 15 * 60_000 },
  '6h': { ms: 6 * 60 * 60_000, toleranceMs: 60 * 60_000 },
};

export interface OutcomeObservation {
  anchorAt: number;
  /** Latest metric-specific target. Retained for backward compatibility. */
  targetAt: number;
  /** Age to targetAt. Metric-specific ages are authoritative for each outcome. */
  actualAgeMs: number;
  priceTargetAt: number | null;
  priceActualAgeMs: number | null;
  liquidityTargetAt: number | null;
  liquidityActualAgeMs: number | null;
  priceReturnPct: number | null;
  liquidityChangePct: number | null;
  signals: TemporalSignalValues;
}

export interface SignalBacktestStat {
  /** Number of non-overlapping price-return pairs. */
  samples: number;
  liquiditySamples: number;
  meanPriceReturnPct: number | null;
  medianPriceReturnPct: number | null;
  positiveReturnRate: number | null;
  meanLiquidityChangePct: number | null;
  pearsonSignalPriceReturn: number | null;
  spearmanSignalPriceReturn: number | null;
}

export interface OutcomeReplayHorizon {
  rawObservations: number;
  /** Non-overlapping anchor intervals used for statistics. */
  observations: number;
  stats: Record<keyof TemporalSignalValues, SignalBacktestStat>;
}

export interface OutcomeReplay {
  horizons: Record<OutcomeHorizon, OutcomeReplayHorizon>;
}

function lowerBoundObservedAt(history: TemporalSignalSnapshot[], targetAt: number): number {
  let lo = 0;
  let hi = history.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (history[mid].observedAt < targetAt) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function nearestTarget(history: TemporalSignalSnapshot[], targetAt: number, toleranceMs: number, afterAt: number): TemporalSignalSnapshot | null {
  // History is sorted. The nearest timestamp can only be the lower-bound row or
  // its immediate predecessor, so target lookup is O(log N), not O(N).
  const index = lowerBoundObservedAt(history, targetAt);
  let best: TemporalSignalSnapshot | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidateIndex of [index - 1, index]) {
    if (candidateIndex < 0 || candidateIndex >= history.length) continue;
    const row = history[candidateIndex];
    if (row.observedAt <= afterAt) continue;
    const distance = Math.abs(row.observedAt - targetAt);
    if (distance <= toleranceMs && distance < bestDistance) {
      best = row;
      bestDistance = distance;
    }
  }
  return best;
}

function temporalSignalValue(row: { signals?: Partial<TemporalSignalValues> | null }, signal: keyof TemporalSignalValues): number | null {
  const signals = row.signals;
  const value = signals?.[signal];
  if (!finite(value)) return null;
  if (signal === 'demandMomentum' || signal === 'distributionRisk' || signal === 'coordination' || signal === 'organicGrowth' || signal === 'smartMoney') {
    return value >= 0 && value <= 100 ? value : null;
  }
  if (signal === 'ofi15m' || signal === 'concentrationVelocity1h' || signal === 'liquidityPressure15m') {
    return value >= -1 && value <= 1 ? value : null;
  }
  return value;
}

function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 5) return null;
  const mx = mean(xs); const my = mean(ys);
  if (mx == null || my == null) return null;
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const ax = xs[i] - mx; const ay = ys[i] - my;
    num += ax * ay; dx += ax * ax; dy += ay * ay;
  }
  if (dx <= EPS || dy <= EPS) return null;
  const out = num / Math.sqrt(dx * dy);
  return finite(out) ? clampSigned(out) : null;
}

function averageRanks(values: number[]): number[] {
  // Sorting numeric indices avoids allocating one {value,index} object per sample for
  // every signal/horizon correlation. This is a hot path at ~10k temporal anchors.
  const order = Array.from({ length: values.length }, (_, index) => index);
  order.sort((a, b) => values[a] - values[b] || a - b);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i + 1;
    const value = values[order[i]];
    while (j < order.length && values[order[j]] === value) j++;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) ranks[order[k]] = avgRank;
    i = j;
  }
  return ranks;
}

function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 5) return null;
  return pearson(averageRanks(xs), averageRanks(ys));
}

function emptyStats(): Record<keyof TemporalSignalValues, SignalBacktestStat> {
  const keys: Array<keyof TemporalSignalValues> = [
    'demandMomentum', 'distributionRisk', 'coordination', 'organicGrowth', 'smartMoney',
    'ofi15m', 'holderGrowth1h', 'concentrationVelocity1h', 'liquidityPressure15m',
  ];
  return Object.fromEntries(keys.map((key) => [key, {
    samples: 0,
    liquiditySamples: 0,
    meanPriceReturnPct: null,
    medianPriceReturnPct: null,
    positiveReturnRate: null,
    meanLiquidityChangePct: null,
    pearsonSignalPriceReturn: null,
    spearmanSignalPriceReturn: null,
  }])) as Record<keyof TemporalSignalValues, SignalBacktestStat>;
}

function selectNonOverlapping(
  rows: OutcomeObservation[],
  targetAt: (row: OutcomeObservation) => number | null = (row) => row.targetAt,
): OutcomeObservation[] {
  const out: OutcomeObservation[] = [];
  let previousTargetAt = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const rowTargetAt = targetAt(row);
    if (!finite(rowTargetAt)) continue;
    if (row.anchorAt < previousTargetAt) continue;
    out.push(row);
    previousTargetAt = rowTargetAt;
  }
  return out;
}

export function computeOutcomeReplay(historyInput: TemporalSignalSnapshot[]): OutcomeReplay {
  // Persistence already returns valid chronological unique rows. Keep that hot path
  // allocation-free; only normalize/deduplicate when a generic caller violates it.
  let fastPath = historyInput.length > 0;
  let previousObservedAt = Number.NEGATIVE_INFINITY;
  for (const row of historyInput) {
    if (row?.schemaVersion !== 1 || !finite(row.observedAt) || row.observedAt <= previousObservedAt) {
      fastPath = false;
      break;
    }
    previousObservedAt = row.observedAt;
  }
  const history = fastPath
    ? historyInput
    : (() => {
        // Generic API remains deterministic with malformed/duplicate timestamps: last
        // supplied row wins for an exact timestamp.
        const byObservedAt = new Map<number, TemporalSignalSnapshot>();
        for (const row of historyInput) {
          if (row?.schemaVersion === 1 && finite(row.observedAt)) byObservedAt.set(row.observedAt, row);
        }
        return [...byObservedAt.values()].sort((a, b) => a.observedAt - b.observedAt);
      })();

  // Outcome labels have their own evidence availability. Do not let a timestamp with
  // missing price hide a nearby valid price label (or vice versa for liquidity).
  // Pre-indexing keeps the per-horizon walk O(N).
  const priceTargetIndices: number[] = [];
  const liquidityTargetIndices: number[] = [];
  for (let i = 0; i < history.length; i++) {
    if (finite(history[i].priceUsd) && history[i].priceUsd! >= 0) priceTargetIndices.push(i);
    if (finite(history[i].liquidityUsd) && history[i].liquidityUsd! >= 0) liquidityTargetIndices.push(i);
  }

  const horizons = {} as Record<OutcomeHorizon, OutcomeReplayHorizon>;
  (Object.keys(OUTCOME_HORIZONS) as OutcomeHorizon[]).forEach((horizon) => {
    const cfg = OUTCOME_HORIZONS[horizon];
    const observations: OutcomeObservation[] = [];
    let priceCursor = 0;
    let liquidityCursor = 0;


    for (let anchorIndex = 0; anchorIndex < history.length; anchorIndex++) {
      const anchor = history[anchorIndex];
      const nominalTargetAt = anchor.observedAt + cfg.ms;

      let priceTarget: TemporalSignalSnapshot | null = null;
      if (finite(anchor.priceUsd) && anchor.priceUsd! > 0) {
        while (priceCursor < priceTargetIndices.length && history[priceTargetIndices[priceCursor]].observedAt < nominalTargetAt) priceCursor++;
        if (priceCursor < priceTargetIndices.length) {
          const candidateIndex = priceTargetIndices[priceCursor];
          if (candidateIndex > anchorIndex) {
            const candidate = history[candidateIndex];
            const delay = candidate.observedAt - nominalTargetAt;
            if (delay >= 0 && delay <= cfg.toleranceMs) priceTarget = candidate;
          }
        }
      }

      let liquidityTarget: TemporalSignalSnapshot | null = null;
      if (finite(anchor.liquidityUsd) && anchor.liquidityUsd! > 0) {
        while (liquidityCursor < liquidityTargetIndices.length && history[liquidityTargetIndices[liquidityCursor]].observedAt < nominalTargetAt) liquidityCursor++;
        if (liquidityCursor < liquidityTargetIndices.length) {
          const candidateIndex = liquidityTargetIndices[liquidityCursor];
          if (candidateIndex > anchorIndex) {
            const candidate = history[candidateIndex];
            const delay = candidate.observedAt - nominalTargetAt;
            if (delay >= 0 && delay <= cfg.toleranceMs) liquidityTarget = candidate;
          }
        }
      }

      const priceReturnPct = priceTarget
        ? ((priceTarget.priceUsd! - anchor.priceUsd!) / anchor.priceUsd!) * 100
        : null;
      const liquidityChangePct = liquidityTarget
        ? ((liquidityTarget.liquidityUsd! - anchor.liquidityUsd!) / anchor.liquidityUsd!) * 100
        : null;
      if (priceReturnPct == null && liquidityChangePct == null) continue;

      const priceTargetAt = priceTarget?.observedAt ?? null;
      const liquidityTargetAt = liquidityTarget?.observedAt ?? null;
      const targetAt = Math.max(priceTargetAt ?? Number.NEGATIVE_INFINITY, liquidityTargetAt ?? Number.NEGATIVE_INFINITY);
      observations.push({
        anchorAt: anchor.observedAt,
        targetAt,
        actualAgeMs: targetAt - anchor.observedAt,
        priceTargetAt,
        priceActualAgeMs: priceTargetAt == null ? null : priceTargetAt - anchor.observedAt,
        liquidityTargetAt,
        liquidityActualAgeMs: liquidityTargetAt == null ? null : liquidityTargetAt - anchor.observedAt,
        priceReturnPct: finite(priceReturnPct) ? priceReturnPct : null,
        liquidityChangePct: finite(liquidityChangePct) ? liquidityChangePct : null,
        signals: anchor.signals,
      });
    }

    // raw observation count is the union of label-bearing anchors. Overall observations
    // use the longest metric-specific interval; individual statistics de-overlap against
    // the target timestamp for that metric.
    const independent = selectNonOverlapping(observations);
    const stats = emptyStats();
    const priceEligible = observations.filter((row) => finite(row.priceReturnPct) && finite(row.priceTargetAt));
    const liquidityEligible = observations.filter((row) => finite(row.liquidityChangePct) && finite(row.liquidityTargetAt));
    const commonPriceRows = selectNonOverlapping(priceEligible, (row) => row.priceTargetAt);
    const commonLiquidityRows = selectNonOverlapping(liquidityEligible, (row) => row.liquidityTargetAt);
    const commonPriceReturns = commonPriceRows.map((row) => row.priceReturnPct!);
    const commonLiquidityChanges = commonLiquidityRows.map((row) => row.liquidityChangePct!);
    const commonPriceSummary = {
      mean: mean(commonPriceReturns),
      median: median(commonPriceReturns),
      positiveRate: commonPriceReturns.length
        ? commonPriceReturns.filter((value) => value > 0).length / commonPriceReturns.length
        : null,
      ranks: commonPriceReturns.length >= 5 && hasVariation(commonPriceReturns) ? averageRanks(commonPriceReturns) : null,
    };
    const commonLiquidityMean = mean(commonLiquidityChanges);

    (Object.keys(stats) as Array<keyof TemporalSignalValues>).forEach((signal) => {
      const priceSignalComplete = priceEligible.every((row) => temporalSignalValue(row, signal) != null);
      const liquiditySignalComplete = liquidityEligible.every((row) => temporalSignalValue(row, signal) != null);
      const priceRows = priceSignalComplete
        ? commonPriceRows
        : selectNonOverlapping(
            priceEligible.filter((row) => temporalSignalValue(row, signal) != null),
            (row) => row.priceTargetAt,
          );
      const liquidityRows = liquiditySignalComplete
        ? commonLiquidityRows
        : selectNonOverlapping(
            liquidityEligible.filter((row) => temporalSignalValue(row, signal) != null),
            (row) => row.liquidityTargetAt,
          );
      const priceReturns = priceSignalComplete ? commonPriceReturns : priceRows.map((row) => row.priceReturnPct!);
      const liquidityChanges = liquiditySignalComplete ? commonLiquidityChanges : liquidityRows.map((row) => row.liquidityChangePct!);
      const signalValues = priceRows.map((row) => temporalSignalValue(row, signal)!);
      const signalVaries = hasVariation(signalValues);
      const priceVaries = hasVariation(priceReturns);
      const signalRanks = signalValues.length >= 5 && signalVaries && priceVaries ? averageRanks(signalValues) : null;
      const returnRanks = signalRanks
        ? priceSignalComplete ? commonPriceSummary.ranks : averageRanks(priceReturns)
        : null;
      stats[signal] = {
        samples: priceRows.length,
        liquiditySamples: liquidityRows.length,
        meanPriceReturnPct: priceSignalComplete ? commonPriceSummary.mean : mean(priceReturns),
        medianPriceReturnPct: priceSignalComplete ? commonPriceSummary.median : median(priceReturns),
        positiveReturnRate: priceSignalComplete
          ? commonPriceSummary.positiveRate
          : priceReturns.length ? priceReturns.filter((value) => value > 0).length / priceReturns.length : null,
        meanLiquidityChangePct: liquiditySignalComplete ? commonLiquidityMean : mean(liquidityChanges),
        pearsonSignalPriceReturn: signalVaries && priceVaries ? pearson(signalValues, priceReturns) : null,
        spearmanSignalPriceReturn: signalRanks && returnRanks ? pearson(signalRanks, returnRanks) : null,
      };
    });
    horizons[horizon] = { rawObservations: observations.length, observations: independent.length, stats };
  });
  return { horizons };
}

// ─────────────────────────────────────────────────────────────
// 7. V3.5 aggregate
// ─────────────────────────────────────────────────────────────

export interface ChainTemporalAnalytics {
  walletBehavior: WalletTemporalBehavior[];
  costBasisLedgers: WalletCostBasisLedger[];
  walletClusters: WalletClusterPersistence[];
  liquidityAdjustedFlow: LiquidityAdjustedFlow;
  holderCohortMigration: HolderCohortMigration;
  outcomeReplay: OutcomeReplay;
  snapshot: TemporalSignalSnapshot;
}
