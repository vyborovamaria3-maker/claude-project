/**
 * Shared blockchain-analysis types for V3.3/V3.4.
 *
 * This module is deliberately pure and dependency-free. Helius re-exports the
 * trade model/helpers for backward compatibility, so there is one canonical
 * RawTrade definition and no runtime import cycle.
 */

export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

/** Canonical normalized on-chain trade, including non-SOL quote pairs. */
export interface RawTrade {
  signature: string;
  timestamp: number; // unix seconds
  slot?: number;
  trader: string;
  type: "buy" | "sell" | "transfer" | "unknown";
  /** Native SOL notional. Zero for a known non-SOL quote. */
  amountSol: number;
  amountTokens: number;
  /** SOL/token only when the quote is SOL; otherwise zero. */
  priceSol: number;
  quoteMint?: string;
  quoteAmount?: number;
  quoteDecimals?: number;
  quoteUsdValue?: number | null;
  fee?: number;
  jitoTipLamports?: number;
  source?: string;
}

/** Pure compatibility helpers used by V3.3 and V3.4. */
export function tradeQuoteAmount(trade: RawTrade): number | null {
  if (typeof trade.quoteAmount === "number" && Number.isFinite(trade.quoteAmount)) return trade.quoteAmount;
  // A known non-SOL quote with a missing quoteAmount is unknown, not zero SOL.
  if (trade.quoteMint && trade.quoteMint !== WRAPPED_SOL_MINT) return null;
  if (typeof trade.amountSol === "number" && Number.isFinite(trade.amountSol) && Math.abs(trade.amountSol) > 0) return trade.amountSol;
  return null;
}

export function tradeQuoteMint(trade: RawTrade): string {
  return trade.quoteMint || (Number.isFinite(trade.amountSol) && Math.abs(trade.amountSol) > 0 ? WRAPPED_SOL_MINT : "unknown");
}

export function isSolQuotedTrade(trade: RawTrade): boolean {
  return tradeQuoteMint(trade) === WRAPPED_SOL_MINT && Number.isFinite(trade.amountSol) && Math.abs(trade.amountSol) > 0;
}

/** Owner-level holder row. `pct` follows the existing V3.3 percent-100 convention. */
export interface HolderAccount {
  address: string;
  tokenAccount?: string;
  tokenAccounts?: string[];
  amount?: number;
  pct: number;
  ownerResolved?: boolean;
  source?: "program_accounts" | "largest_accounts" | "fixture";
  holderSetComplete?: boolean;
  /** Exact owner count when a full token-account scan was performed. */
  totalHolderCount?: number | null;
}

/** Historical per-wallet/per-token aggregate persisted by the V3.x data layer. */
export function exactHolderCount(holders: HolderAccount[]): number | null {
  if (holders.length === 0) return null;
  const counts = holders
    .map((holder) => holder.totalHolderCount)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const unique = new Set(counts);
  if (unique.size === 1) return [...unique][0];
  return holders.every((holder) => holder.holderSetComplete === true) ? holders.length : null;
}

export interface WalletTokenHistory {
  mint: string;
  buys: number;
  sells: number;
  volumeSol: number;
  pnlSol: number;
  pnlPercent: number;
  isFresh: boolean;
  isWash: boolean;
  bundleId: string | null;
  updatedAt: number;
  /** Optional exact fields for V3.4. Absent means unknown, never zero. */
  realizedPnlSol?: number | null;
  unrealizedPnlSol?: number | null;
  tradeCount?: number | null;
  medianHoldSlots?: number | null;
}

/** Verified or partial native-funding edge. */
export interface FundingEdge {
  source: string;
  target: string;
  signature: string;
  lamports: number;
  blockTime: number | null;
  historyComplete: boolean;
  confidence: number;
}

/** Optional full holder snapshot used by V3.4 churn/baseline calculations. */
export interface HolderSnapshot {
  timestamp: number; // unix milliseconds
  holders?: HolderAccount[];
  /** Percent-100 top-10 share when full holder rows are not persisted. */
  top10Pct?: number | null;
}
