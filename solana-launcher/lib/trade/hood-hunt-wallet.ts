// Evidence-first wallet assessment. This does not submit orders or claim executable fills.
// The copy model uses the first later observed trade, and is only an indicative backtest.

export type HoodHuntWalletStatus = "Копировать" | "Следить" | "Проверить" | "Пропустить";

export interface ObservedSwap {
  mint: string;
  signature: string;
  trader: string;
  side: "buy" | "sell";
  timestamp: number; // Unix seconds
  slot: number | null;
  legIndex?: number;
  amountSol: number;
  amountTokens: number;
  priceSol: number; // SOL per token
  feeSol?: number | null;
  tipSol?: number | null;
}

export interface CopyModelAssumptions {
  buySol: number;
  copyFeeRatePerSide: number;
  platformFeeRatePerSide: number;
  tipSolPerSide: number;
}

export const DEFAULT_COPY_ASSUMPTIONS: CopyModelAssumptions = {
  buySol: 0.5,
  copyFeeRatePerSide: 0.01,
  platformFeeRatePerSide: 0,
  tipSolPerSide: 0.001,
};

export interface WalletTokenAssessment {
  mint: string;
  firstBuyAt: number;
  lastSellAt: number | null;
  buyCount: number;
  sellCount: number;
  closed: boolean;
  pnlSol: number | null;
  holdSeconds: number | null;
  flip: boolean | null;
  sniperEntry: boolean | null;
  selfCreated: boolean | null;
  modeledCopyRoiPct: number | null;
}

export interface HoodHuntWalletAssessment {
  wallet: string;
  status: HoodHuntWalletStatus;
  reasons: string[];
  observedTokens: number;
  closedTokens: number;
  pnlSol: number | null;
  pnl7dSol: number | null;
  winRate: number | null;
  profitFactor: number | null;
  medianHoldSeconds: number | null;
  flipRate: number | null;
  sniperEntryRate: number | null;
  selfCreatedRate: number | null;
  oneBuyOneSellRate: number | null;
  modeledCopy: {
    samples: number;
    averageRoiPct: number | null;
    profitableRate: number | null;
    assumptions: CopyModelAssumptions;
    note: string;
  };
  limitations: string[];
  tokens: WalletTokenAssessment[];
}

const finitePositive = (n: number): boolean => Number.isFinite(n) && n > 0;
const median = (items: number[]): number | null => {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const ratio = (items: Array<boolean | null>): number | null => {
  const known = items.filter((v): v is boolean => v !== null);
  return known.length ? known.filter(Boolean).length / known.length : null;
};
const timestamp = (v: ObservedSwap): number => v.timestamp > 10_000_000_000 ? v.timestamp / 1000 : v.timestamp;

function ordered(a: ObservedSwap, b: ObservedSwap): number {
  const aSlot = a.slot ?? Number.POSITIVE_INFINITY;
  const bSlot = b.slot ?? Number.POSITIVE_INFINITY;
  return aSlot - bSlot || timestamp(a) - timestamp(b)
    || a.signature.localeCompare(b.signature) || (a.legIndex ?? 0) - (b.legIndex ?? 0);
}

function laterTrade(target: ObservedSwap, tokenTrades: ObservedSwap[]): ObservedSwap | null {
  // A strictly higher slot is unambiguous ordering. With missing slots use later time.
  return tokenTrades.find((event) => finitePositive(event.priceSol)
    && (target.slot != null && event.slot != null
      ? event.slot > target.slot
      : timestamp(event) > timestamp(target))) ?? null;
}

function copyRoi(args: {
  firstBuy: ObservedSwap;
  lastSell: ObservedSwap;
  tokenTrades: ObservedSwap[];
  assumptions: CopyModelAssumptions;
}): number | null {
  const { firstBuy, lastSell, tokenTrades, assumptions } = args;
  const entry = laterTrade(firstBuy, tokenTrades);
  const exit = laterTrade(lastSell, tokenTrades);
  if (!entry || !exit || ordered(entry, exit) >= 0) return null;
  const { buySol, copyFeeRatePerSide, platformFeeRatePerSide, tipSolPerSide } = assumptions;
  if (![buySol, copyFeeRatePerSide, platformFeeRatePerSide, tipSolPerSide].every(Number.isFinite)
      || buySol <= 0 || copyFeeRatePerSide < 0 || platformFeeRatePerSide < 0 || tipSolPerSide < 0) return null;
  const entryCost = buySol * (1 + copyFeeRatePerSide + platformFeeRatePerSide) + tipSolPerSide;
  const amountTokens = buySol / entry.priceSol;
  const saleProceeds = amountTokens * exit.priceSol * (1 - copyFeeRatePerSide - platformFeeRatePerSide) - tipSolPerSide;
  if (entryCost <= 0 || !Number.isFinite(saleProceeds)) return null;
  return Math.max(-100, Math.min(1_000, (saleProceeds - entryCost) / entryCost * 100));
}

export function evaluateHoodHuntWallet(args: {
  wallet: string;
  trades: ObservedSwap[];
  creationSlots?: Record<string, number | null>;
  tokenCreators?: Record<string, string | null>;
  balanceSol?: number | null;
  nowSec?: number;
  assumptions?: CopyModelAssumptions;
}): HoodHuntWalletAssessment {
  const assumptions = args.assumptions ?? DEFAULT_COPY_ASSUMPTIONS;
  const nowSec = args.nowSec ?? Math.floor(Date.now() / 1000);
  const trades = args.trades.filter((row) => row.mint && finitePositive(row.priceSol)
    && finitePositive(row.amountTokens) && finitePositive(row.amountSol)
    && Number.isFinite(timestamp(row))).sort(ordered);
  const byMint = new Map<string, ObservedSwap[]>();
  for (const row of trades) {
    const list = byMint.get(row.mint) ?? [];
    list.push(row);
    byMint.set(row.mint, list);
  }
  const tokens: WalletTokenAssessment[] = [];
  let observedFeeGaps = false;
  const targetTrades = trades.filter((row) => row.trader === args.wallet);
  for (const [mint, tokenTrades] of byMint) {
    const own = tokenTrades.filter((row) => row.trader === args.wallet);
    const buys = own.filter((row) => row.side === "buy");
    const sells = own.filter((row) => row.side === "sell");
    if (!buys.length) continue;
    const firstBuy = buys[0];
    const lastSell = sells.at(-1) ?? null;
    const bought = buys.reduce((sum, row) => sum + row.amountTokens, 0);
    const sold = sells.reduce((sum, row) => sum + row.amountTokens, 0);
    const closed = lastSell !== null && bought > 0 && sold >= bought * 0.99;
    const entrySlot = firstBuy.slot;
    const creationSlot = args.creationSlots?.[mint] ?? null;
    const flip = closed && entrySlot != null && lastSell?.slot != null
      ? lastSell.slot - entrySlot <= 1 : null;
    const sniperEntry = entrySlot != null && creationSlot != null && entrySlot >= creationSlot
      ? entrySlot - creationSlot <= 2 : null;
    const creator = args.tokenCreators?.[mint] ?? null;
    const selfCreated = creator ? creator === args.wallet : null;
    let pnlSol: number | null = null;
    if (closed) {
      const feeGaps = own.some((row) => row.feeSol == null || row.tipSol == null);
      observedFeeGaps ||= feeGaps;
      const boughtSol = buys.reduce((sum, row) => sum + row.amountSol + (row.feeSol ?? 0) + (row.tipSol ?? 0), 0);
      const soldSol = sells.reduce((sum, row) => sum + row.amountSol - (row.feeSol ?? 0) - (row.tipSol ?? 0), 0);
      pnlSol = soldSol - boughtSol;
    }
    tokens.push({
      mint,
      firstBuyAt: timestamp(firstBuy),
      lastSellAt: closed && lastSell ? timestamp(lastSell) : null,
      buyCount: buys.length, sellCount: sells.length, closed, pnlSol,
      holdSeconds: closed && lastSell ? Math.max(0, timestamp(lastSell) - timestamp(firstBuy)) : null,
      flip, sniperEntry, selfCreated,
      modeledCopyRoiPct: closed && lastSell
        ? copyRoi({ firstBuy, lastSell, tokenTrades, assumptions }) : null,
    });
  }
  const closed = tokens.filter((token) => token.closed && token.pnlSol != null);
  const winners = closed.filter((token) => token.pnlSol! > 0);
  const profits = closed.reduce((sum, t) => sum + Math.max(0, t.pnlSol ?? 0), 0);
  const losses = closed.reduce((sum, t) => sum + Math.max(0, -(t.pnlSol ?? 0)), 0);
  const recent = closed.filter((t) => t.firstBuyAt >= nowSec - 7 * 86400 && t.firstBuyAt <= nowSec);
  const modeled = tokens.filter((t) => t.modeledCopyRoiPct !== null)
    .sort((a, b) => b.firstBuyAt - a.firstBuyAt).slice(0, 60);
  const copyAvg = modeled.length
    ? modeled.reduce((sum, t) => sum + t.modeledCopyRoiPct!, 0) / modeled.length : null;
  const copyProfitable = modeled.length
    ? modeled.filter((t) => t.modeledCopyRoiPct! > 0).length / modeled.length : null;
  const pnl = closed.length ? closed.reduce((sum, t) => sum + t.pnlSol!, 0) : null;
  const profitFactor = closed.length && losses > 0 ? profits / losses : null;
  const sniperRate = ratio(tokens.map((t) => t.sniperEntry));
  const selfCreatedRate = ratio(tokens.map((t) => t.selfCreated));
  const flipRate = ratio(closed.map((t) => t.flip));
  const hold = median(closed.map((t) => t.holdSeconds).filter((v): v is number => v !== null));
  const wr = closed.length ? winners.length / closed.length : null;
  const oneBuyOneSellRate = closed.length
    ? closed.filter((t) => t.buyCount === 1 && t.sellCount === 1).length / closed.length : null;
  const limitations = [
    "Only locally observed swap rows are included. Transfers, open balances, missing history and execution slippage can invalidate historical PnL.",
    "Copy exits/entries use the first observed later trade, not an executable quote. Actual same-slot latency and price impact are unknown.",
    "The copy model caps gains at +1000% and assumes the specified flat buy size, fees and tips.",
  ];
  if (observedFeeGaps) limitations.push("Some on-chain transaction fees/tips are missing; historical PnL omits those unknown costs.");
  if (sniperRate === null) limitations.push("Token creation slots are not verified: sniper-entry rate is unknown.");
  if (args.balanceSol == null) limitations.push("Current SOL balance was not fetched.");
  if (targetTrades.length === 0) limitations.push("No observed swaps for this wallet.");
  const reasons: string[] = [];
  let status: HoodHuntWalletStatus = "Следить";
  if ((pnl !== null && pnl < 0) || (copyAvg !== null && copyAvg < 0)
      || (sniperRate !== null && sniperRate > 0.3)
      || (selfCreatedRate !== null && selfCreatedRate > 0.05)) {
    status = "Пропустить";
    reasons.push("Negative PnL/model or high sniper/self-created share.");
  } else if (observedFeeGaps || (tokens.length > 0 && modeled.length < Math.min(10, closed.length))
    || (tokens.length > 0 && tokens.some((t) => t.sniperEntry === null))) {
    status = "Проверить";
    reasons.push("Incomplete trading history, fees or verified creation-slot evidence.");
  } else if (args.balanceSol != null && args.balanceSol >= 1 && closed.length >= 15
    && (wr ?? 0) >= 0.5 && (profitFactor ?? 0) >= 1.5
    && recent.length > 0 && recent.reduce((sum, t) => sum + t.pnlSol!, 0) >= 0
    && (copyAvg ?? -1) >= 0 && (copyProfitable ?? 0) >= 0.5
    && (hold ?? 0) >= 60 && (flipRate ?? 1) <= 0.05
    && (sniperRate ?? 1) <= 0.3 && (selfCreatedRate ?? 1) <= 0.05) {
    status = "Копировать";
    reasons.push("All defined thresholds are met on observed data; live execution remains unverified.");
  } else {
    reasons.push("Insufficient evidence or one or more eligibility thresholds are not met.");
  }
  return {
    wallet: args.wallet, status, reasons, observedTokens: tokens.length, closedTokens: closed.length,
    pnlSol: pnl,
    pnl7dSol: recent.length ? recent.reduce((sum, t) => sum + t.pnlSol!, 0) : null,
    winRate: wr, profitFactor, medianHoldSeconds: hold, flipRate, sniperEntryRate: sniperRate,
    selfCreatedRate, oneBuyOneSellRate,
    modeledCopy: {
      samples: modeled.length, averageRoiPct: copyAvg, profitableRate: copyProfitable,
      assumptions,
      note: "Indicative next-observed-trade model; NOT actual Blizz fills or a live profit prediction.",
    },
    limitations, tokens,
  };
}
