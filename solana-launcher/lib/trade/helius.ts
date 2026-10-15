// data-tag: lib.trade.helius
// Helius integration: fetch enriched parsed transactions for a token mint
// Docs: https://docs.helius.dev/solana-apis/enhanced-transactions-api

import { appendHeliusApiKey, getHeliusApiKeys, isHeliusRetryableStatus } from "./helius-rotation";
import type { RawTrade } from "./chain/types";

// Re-export the canonical trade model so legacy importers keep working while
// there is exactly one RawTrade definition (see chain/types.ts).
export type { RawTrade } from "./chain/types";
export { WRAPPED_SOL_MINT } from "./chain/types";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const HELIUS_RPC =
  process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
  process.env.HELIUS_RPC_URL ||
  process.env.NEXT_PUBLIC_RPC_URL ||
  "https://api.mainnet-beta.solana.com";

const HELIUS_API_KEYS = getHeliusApiKeys();

export interface HeliusEnrichedTx {
  signature: string;
  timestamp: number;
  type?: string;
  source?: string;
  feePayer?: string;
  fee?: number;
  tokenTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    mint: string;
    tokenAmount: number;
  }>;
  nativeTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    amount: number; // lamports
  }>;
  events?: {
    swap?: {
      nativeInput?: { account: string; amount: string };
      nativeOutput?: { account: string; amount: string };
      tokenInputs?: Array<{ userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }>;
      tokenOutputs?: Array<{ userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }>;
    };
  };
}

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Fetch enriched parsed transactions for an address (mint) from Helius,
 * with coverage metadata so callers can grade evidence provenance.
 * Returns up to `maxTxs` transactions (paginates by `before`).
 */
export type EnrichedTxMeta = {
  transactions: HeliusEnrichedTx[];
  /** Oldest fetched timestamp (unix seconds); null when nothing was fetched. */
  oldestTimestamp: number | null;
  /** True when pagination ended because the API reported no further history. */
  exhausted: boolean;
  /** True when the `maxTxs` bound stopped pagination before history ended. */
  truncated: boolean;
  /** Incremental mode stopped at an already-persisted signature, not chain exhaustion. */
  reachedKnownHistory?: boolean;
};

const HELIUS_TIMEOUT_MS = (() => {
  const value = Number(process.env.HELIUS_FETCH_TIMEOUT_MS || 12_000);
  return Number.isFinite(value) ? Math.max(1000, Math.min(60_000, value)) : 12_000;
})();
const HELIUS_MAX_ROUNDS = (() => {
  const value = Number(process.env.HELIUS_FETCH_MAX_ROUNDS || 2);
  return Number.isFinite(value) ? Math.max(1, Math.min(4, Math.floor(value))) : 2;
})();

async function fetchHeliusPage(
  mint: string,
  before: string | undefined,
  limit: number,
  keys: string[],
  includeTokenAccounts: boolean = false,
): Promise<HeliusEnrichedTx[]> {
  let lastError: Error | null = null;
  for (let round = 0; round < HELIUS_MAX_ROUNDS; round++) {
    for (const apiKey of keys) {
      const url = new URL(appendHeliusApiKey("https://api.helius.xyz/v0/addresses/" + mint + "/transactions", apiKey));
      url.searchParams.set("limit", String(limit));
      // Wallet history must include changes to SPL token accounts, not just the owner address.
      if (includeTokenAccounts) url.searchParams.set("token-accounts", "balanceChanged");
      if (before) url.searchParams.set("before", before);
      try {
        const response = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(HELIUS_TIMEOUT_MS),
          cache: "no-store",
        });
        if (!response.ok) {
          if (!isHeliusRetryableStatus(response.status)) throw new Error("Helius HTTP " + response.status);
          lastError = new Error("Helius retryable HTTP " + response.status);
          continue;
        }
        const page: unknown = await response.json();
        if (!Array.isArray(page)) throw new Error("Helius page has invalid shape");
        return page as HeliusEnrichedTx[];
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Non-retryable 4xx means no API key rotation will help.
        if (/^Helius HTTP 4\d\d$/.test(lastError.message)) throw lastError;
      }
    }
    if (round + 1 < HELIUS_MAX_ROUNDS) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1500, 250 * 2 ** round)));
    }
  }
  throw lastError ?? new Error("All Helius API keys failed");
}

export async function fetchEnrichedTxsForMintWithMeta(
  mint: string,
  maxTxs: number = 1000,
  stopAtSignatures: ReadonlySet<string> | null = null,
  startBefore?: string,
  includeTokenAccounts: boolean = false,
): Promise<EnrichedTxMeta> {
  const keys = HELIUS_API_KEYS;
  if (!keys.length) {
    throw new Error("Helius API key not configured (set HELIUS_API_KEY or HELIUS_API_KEYS)");
  }
  if (!Number.isInteger(maxTxs) || maxTxs < 1) throw new Error("maxTxs must be a positive integer");

  const all: HeliusEnrichedTx[] = [];
  const seen = new Set<string>();
  let before: string | undefined = startBefore;
  let exhausted = false;
  let reachedKnownHistory = false;
  const seenCursors = new Set<string>();

  while (all.length < maxTxs) {
    const requested = Math.min(100, maxTxs - all.length);
    const page = await fetchHeliusPage(mint, before, requested, keys, includeTokenAccounts);
    if (!page.length) {
      exhausted = true;
      break;
    }
    for (const tx of page) {
      if (!tx || typeof tx.signature !== "string" || !tx.signature) continue;
      if (stopAtSignatures?.has(tx.signature)) {
        reachedKnownHistory = true;
        break;
      }
      if (seen.has(tx.signature)) continue;
      seen.add(tx.signature);
      all.push(tx);
    }
    if (reachedKnownHistory) break;
    // A short filtered page is not proof of archive exhaustion.
    // Only an empty page is considered exhausted.
    const nextBefore = page[page.length - 1]?.signature;
    if (!nextBefore || nextBefore === before || seenCursors.has(nextBefore)) {
      throw new Error("Helius pagination stalled: cursor repeated");
    }
    seenCursors.add(nextBefore);
    before = nextBefore;
  }

  const truncated = !exhausted && all.length >= maxTxs;
  const bounded = all.slice(0, maxTxs);
  const oldestTimestamp = bounded.reduce<number | null>(
    (oldest, tx) => {
      const ts = tx.timestamp;
      if (!Number.isFinite(ts)) return oldest;
      return oldest == null || ts < oldest ? ts : oldest;
    },
    null,
  );
  return { transactions: bounded, oldestTimestamp, exhausted, truncated, reachedKnownHistory };
}

/**
 * Fetch enriched parsed transactions for an address (mint) from Helius.
 * Returns up to `maxTxs` transactions (paginates by `before`).
 */
export async function fetchEnrichedTxsForMint(
  mint: string,
  maxTxs: number = 1000
): Promise<HeliusEnrichedTx[]> {
  const result = await fetchEnrichedTxsForMintWithMeta(mint, maxTxs);
  return result.transactions;
}

/**
 * Convert Helius enriched txs into normalized trades for a specific mint.
 * Detects SOL↔token swaps via tokenTransfers + nativeTransfers correlation
 * or via parsed swap events.
 */
export function txsToTrades(txs: HeliusEnrichedTx[], mint: string): RawTrade[] {
  const trades: RawTrade[] = [];

  for (const tx of txs) {
    const trade = extractTrade(tx, mint);
    if (trade) trades.push(trade);
  }

  return trades;
}

function extractTrade(tx: HeliusEnrichedTx, mint: string): RawTrade | null {
  // 1. Try parsed swap event first (most reliable for AMM swaps)
  const swap = tx.events?.swap;
  if (swap) {
    // SOL → token (BUY)
    const tokenOut = swap.tokenOutputs?.find((o) => o.mint === mint);
    if (tokenOut && swap.nativeInput) {
      const amountSol = Number(swap.nativeInput.amount) / LAMPORTS_PER_SOL;
      const decimals = tokenOut.rawTokenAmount.decimals;
      const amountTokens = Number(tokenOut.rawTokenAmount.tokenAmount) / 10 ** decimals;
      if (amountSol > 0 && amountTokens > 0) {
        return {
          signature: tx.signature,
          timestamp: tx.timestamp,
          trader: tokenOut.userAccount || swap.nativeInput.account || tx.feePayer || "",
          type: "buy",
          amountSol,
          amountTokens,
          priceSol: amountSol / amountTokens,
          fee: tx.fee,
          source: tx.source,
        };
      }
    }
    // token → SOL (SELL)
    const tokenIn = swap.tokenInputs?.find((i) => i.mint === mint);
    if (tokenIn && swap.nativeOutput) {
      const amountSol = Number(swap.nativeOutput.amount) / LAMPORTS_PER_SOL;
      const decimals = tokenIn.rawTokenAmount.decimals;
      const amountTokens = Number(tokenIn.rawTokenAmount.tokenAmount) / 10 ** decimals;
      if (amountSol > 0 && amountTokens > 0) {
        return {
          signature: tx.signature,
          timestamp: tx.timestamp,
          trader: tokenIn.userAccount || swap.nativeOutput.account || tx.feePayer || "",
          type: "sell",
          amountSol,
          amountTokens,
          priceSol: amountSol / amountTokens,
          fee: tx.fee,
          source: tx.source,
        };
      }
    }
  }

  // Do not infer a swap by pairing the largest SOL/token transfers:
  // unrelated transfers, LP operations and aggregator legs can look identical.
  return null;
}

/**
 * Get the first transaction timestamp (account creation proxy) for a wallet.
 * Used for Fresh Wallet detection (created < 1 hour ago).
 */
export async function getWalletFirstSeen(address: string): Promise<number | null> {
  const keys = HELIUS_API_KEYS.length > 0 ? HELIUS_API_KEYS : [];
  if (keys.length === 0) return null;
  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    try {
      const apiKey = keys[attempt] ?? "";
      const url = new URL(appendHeliusApiKey(`https://api.helius.xyz/v0/addresses/${address}/transactions`, apiKey));
      url.searchParams.set("limit", "100");
      // Single page is enough for fresh-detection (<1h old wallets have very few txs).
      // If wallet has >100 txs, it's definitely not fresh — return earliest of this page as approximation.
      const r = await fetch(url.toString(), { signal: AbortSignal.timeout(HELIUS_TIMEOUT_MS), cache: "no-store" });
      if (!r.ok) {
        if (isHeliusRetryableStatus(r.status) && attempt < keys.length - 1) continue;
        return null;
      }
      const page = (await r.json()) as HeliusEnrichedTx[];
      if (!Array.isArray(page) || page.length === 0) return null;
      // A full newest-first page is not proof of the wallet's first activity.
      if (page.length >= 100) return null;
      const earliest = Math.min(...page.map((t) => t.timestamp || Infinity));
      return Number.isFinite(earliest) ? earliest : null;
    } catch {
      if (attempt === keys.length - 1) return null;
    }
  }
  return null;
}

/**
 * Batch fetch native SOL balance for multiple wallets via RPC getMultipleAccounts.
 */
export async function fetchSolBalances(addresses: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (addresses.length === 0) return result;

  // RPC supports up to 100 accounts per call
  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += 100) chunks.push(addresses.slice(i, i + 100));

  for (const chunk of chunks) {
    try {
      const r = await fetch(HELIUS_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getMultipleAccounts",
          params: [chunk, { encoding: "base64" }],
        }),
      });
      const json = await r.json();
      const arr = json?.result?.value;
      if (!Array.isArray(arr)) continue;
      chunk.forEach((addr, i) => {
        const lamports = arr[i]?.lamports;
        if (typeof lamports === "number") {
          result.set(addr, lamports / LAMPORTS_PER_SOL);
        }
      });
    } catch {
      // skip chunk on error
    }
  }
  return result;
}
