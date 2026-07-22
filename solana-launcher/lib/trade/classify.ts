// data-tag: lib.trade.classify
// Wallet classifiers: Fresh, Smart, Bundle, Wash Trader, Related
import type { RawTrade } from "./helius";

const HOUR_SEC = 3600;
const MIN_SEC = 60;

export interface WalletAggregate {
  address: string;
  trades: RawTrade[];
  buys: number;
  sells: number;
  totalSpentSol: number;     // SOL out (buying)
  totalReceivedSol: number;  // SOL in (selling)
  totalTokensBought: number;
  totalTokensSold: number;
  volumeSol: number;
  firstSeen: number;
  lastSeen: number;
}

export function aggregateByWallet(trades: RawTrade[]): Map<string, WalletAggregate> {
  const map = new Map<string, WalletAggregate>();
  for (const t of trades) {
    if (!t.trader) continue;
    let w = map.get(t.trader);
    if (!w) {
      w = {
        address: t.trader,
        trades: [],
        buys: 0,
        sells: 0,
        totalSpentSol: 0,
        totalReceivedSol: 0,
        totalTokensBought: 0,
        totalTokensSold: 0,
        volumeSol: 0,
        firstSeen: t.timestamp,
        lastSeen: t.timestamp,
      };
      map.set(t.trader, w);
    }
    w.trades.push(t);
    w.volumeSol += t.amountSol;
    if (t.type === "buy") {
      w.buys++;
      w.totalSpentSol += t.amountSol;
      w.totalTokensBought += t.amountTokens;
    } else if (t.type === "sell") {
      w.sells++;
      w.totalReceivedSol += t.amountSol;
      w.totalTokensSold += t.amountTokens;
    }
    if (t.timestamp < w.firstSeen) w.firstSeen = t.timestamp;
    if (t.timestamp > w.lastSeen) w.lastSeen = t.timestamp;
  }
  return map;
}

// ── Fresh Wallet detection ───────────────────────────────────
// First-seen-anywhere < 1 hour. Use wallet's overall earliest tx (fetched separately).
export function isFreshWallet(walletFirstSeen: number, nowSec: number = Date.now() / 1000): boolean {
  return nowSec - walletFirstSeen < HOUR_SEC;
}

// ── PnL (FIFO) ───────────────────────────────────────────────
// Walk trades in chronological order; on each sell, pop oldest buys to compute realized P&L.
// Unrealized = remaining tokens × current price.
export interface PnLResult {
  realizedSol: number;    // realized P&L (closed positions)
  unrealizedSol: number;  // mark-to-market on remaining tokens
  pnlSol: number;         // realized + unrealized
  pnlPercent: number;     // pnlSol / totalSpentSol * 100
  remainingTokens: number;
  avgCostSol: number;     // average cost basis SOL/token for remaining tokens
}

export function calcFifoPnL(trades: RawTrade[], currentPriceSol: number): PnLResult {
  // Stack of buy lots: [{ tokens, costSolPerToken }]
  const lots: Array<{ tokens: number; costPerToken: number }> = [];
  let realizedSol = 0;
  let totalSpent = 0;

  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  for (const t of sorted) {
    if (t.type === "buy" && t.amountTokens > 0) {
      lots.push({ tokens: t.amountTokens, costPerToken: t.priceSol });
      totalSpent += t.amountSol;
    } else if (t.type === "sell" && t.amountTokens > 0) {
      let remaining = t.amountTokens;
      const sellPrice = t.priceSol;
      while (remaining > 0 && lots.length > 0) {
        const lot = lots[0];
        const take = Math.min(remaining, lot.tokens);
        realizedSol += take * (sellPrice - lot.costPerToken);
        lot.tokens -= take;
        remaining -= take;
        if (lot.tokens <= 1e-9) lots.shift();
      }
      // If sells exceed buys (e.g. tokens received via airdrop), treat overflow as pure profit
      if (remaining > 0) realizedSol += remaining * sellPrice;
    }
  }

  const remainingTokens = lots.reduce((s, l) => s + l.tokens, 0);
  const remainingCost = lots.reduce((s, l) => s + l.tokens * l.costPerToken, 0);
  const remainingValue = remainingTokens * currentPriceSol;
  const unrealizedSol = remainingValue - remainingCost;
  const pnlSol = realizedSol + unrealizedSol;
  const pnlPercent = totalSpent > 0 ? (pnlSol / totalSpent) * 100 : 0;
  const avgCostSol = remainingTokens > 1e-9 ? remainingCost / remainingTokens : 0;

  return { realizedSol, unrealizedSol, pnlSol, pnlPercent, remainingTokens, avgCostSol };
}

// ── Bundle detection ─────────────────────────────────────────
// Group wallets that buy within `windowSec` of each other with similar amounts (±tolerance).
// Assigns sequential IDs (Bundle1, Bundle2, …).
export interface BundleAssignment {
  bundleId: string; // "Bundle1", "Bundle2", …
  wallets: string[];
  startTs: number;
  totalVolumeSol: number;
  avgBuySol: number;
}

export function detectBundles(
  trades: RawTrade[],
  opts: { windowSec?: number; amountTolerance?: number; minWallets?: number } = {}
): { bundles: BundleAssignment[]; walletBundleId: Map<string, string> } {
  const windowSec = opts.windowSec ?? 5;          // buys within 5s
  const amountTolerance = opts.amountTolerance ?? 0.05; // ±5%
  const minWallets = opts.minWallets ?? 2;

  const buys = trades.filter((t) => t.type === "buy").sort((a, b) => a.timestamp - b.timestamp);
  const assigned = new Set<string>(); // signatures already in a bundle
  const bundles: BundleAssignment[] = [];
  const walletBundleId = new Map<string, string>();
  let counter = 0;

  for (let i = 0; i < buys.length; i++) {
    const seed = buys[i];
    if (assigned.has(seed.signature)) continue;

    const cluster: RawTrade[] = [seed];
    const seenWallets = new Set([seed.trader]);

    for (let j = i + 1; j < buys.length; j++) {
      const next = buys[j];
      if (assigned.has(next.signature)) continue;
      if (next.timestamp - seed.timestamp > windowSec) break;
      if (seenWallets.has(next.trader)) continue; // same wallet, not a co-buyer
      const amountRatio = Math.abs(next.amountSol - seed.amountSol) / Math.max(seed.amountSol, 1e-9);
      if (amountRatio <= amountTolerance) {
        cluster.push(next);
        seenWallets.add(next.trader);
      }
    }

    if (seenWallets.size >= minWallets) {
      counter++;
      const id = `Bundle${counter}`;
      for (const t of cluster) {
        assigned.add(t.signature);
        walletBundleId.set(t.trader, id);
      }
      bundles.push({
        bundleId: id,
        wallets: Array.from(seenWallets),
        startTs: seed.timestamp,
        totalVolumeSol: cluster.reduce((s, t) => s + t.amountSol, 0),
        avgBuySol: cluster.reduce((s, t) => s + t.amountSol, 0) / cluster.length,
      });
    }
  }

  return { bundles, walletBundleId };
}

// ── Wash trader heuristic ────────────────────────────────────
// Flags wallets where:
//   - buy and sell happen within `quickSec` of each other (suspicious in/out cycling)
//   - OR more than `cycleThreshold` matched buy/sell pairs detected
//   - OR very high trade frequency (>50 trades) with low net position
export interface WashFlag {
  isSuspicious: boolean;
  confidence: number; // 0..100
  reasons: string[];
}

export function detectWashTrading(w: WalletAggregate, opts: { quickSec?: number } = {}): WashFlag {
  const quickSec = opts.quickSec ?? 60;
  const reasons: string[] = [];
  let score = 0;

  // 1. Quick in/out cycles
  const sorted = [...w.trades].sort((a, b) => a.timestamp - b.timestamp);
  let quickCycles = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.type !== cur.type && cur.timestamp - prev.timestamp < quickSec) quickCycles++;
  }
  if (quickCycles >= 3) {
    score += Math.min(40, quickCycles * 5);
    reasons.push(`${quickCycles} quick buy/sell cycles (<${quickSec}s)`);
  }

  // 2. Equal buy and sell volumes (round-trip wash)
  const ratio = Math.min(w.totalSpentSol, w.totalReceivedSol) / Math.max(w.totalSpentSol, w.totalReceivedSol || 1e-9);
  if (w.buys >= 3 && w.sells >= 3 && ratio > 0.9) {
    score += 25;
    reasons.push(`Buy/sell volumes near-equal (${(ratio * 100).toFixed(0)}%)`);
  }

  // 3. High frequency with low net token holding
  const netTokens = w.totalTokensBought - w.totalTokensSold;
  const netRatio = Math.abs(netTokens) / Math.max(w.totalTokensBought, 1e-9);
  if (w.trades.length > 20 && netRatio < 0.05) {
    score += 20;
    reasons.push(`${w.trades.length} trades but ~zero net position`);
  }

  return {
    isSuspicious: score >= 35,
    confidence: Math.min(100, score),
    reasons,
  };
}

// ── Related wallets (funded by same source) ──────────────────
// Two wallets are "related" if they share a common funding source within a short window,
// OR have direct SOL transfers between them.
// For MVP we use trade-time proximity + bundle membership as proxy.
export function findRelatedWallets(
  trades: RawTrade[],
  proximitySec: number = 30
): Map<string, Set<string>> {
  const buys = trades.filter((t) => t.type === "buy").sort((a, b) => a.timestamp - b.timestamp);
  const related = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    if (!related.has(a)) related.set(a, new Set());
    if (!related.has(b)) related.set(b, new Set());
    related.get(a)!.add(b);
    related.get(b)!.add(a);
  };

  for (let i = 0; i < buys.length; i++) {
    for (let j = i + 1; j < buys.length; j++) {
      if (buys[j].timestamp - buys[i].timestamp > proximitySec) break;
      link(buys[i].trader, buys[j].trader);
    }
  }
  return related;
}
