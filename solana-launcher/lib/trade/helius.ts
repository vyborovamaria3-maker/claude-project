// data-tag: lib.trade.helius
// Helius integration: fetch enriched parsed transactions for a token mint
// Docs: https://docs.helius.dev/solana-apis/enhanced-transactions-api

import { appendHeliusApiKey, getRuntimeHeliusApiKeys, isHeliusRetryableStatus } from "./helius-rotation";

const HELIUS_RPC =
  process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
  process.env.HELIUS_RPC_URL ||
  process.env.NEXT_PUBLIC_RPC_URL ||
  "https://api.mainnet-beta.solana.com";

export interface RawTrade {
  signature: string;
  timestamp: number; // unix seconds
  trader: string;
  type: "buy" | "sell" | "transfer" | "unknown";
  amountSol: number;
  amountTokens: number;
  priceSol: number; // SOL per token
  fee?: number;
  source?: string; // PUMP_FUN / RAYDIUM etc
}

interface HeliusEnrichedTx {
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
 * Fetch enriched parsed transactions for an address (mint) from Helius.
 * Returns up to `maxTxs` transactions (paginates by `before`).
 */
export async function fetchEnrichedTxsForMint(
  mint: string,
  maxTxs: number = 1000
): Promise<HeliusEnrichedTx[]> {
  const keys = await getRuntimeHeliusApiKeys();
  if (keys.length === 0) {
    throw new Error("Helius API key not configured (Admin -> Integrations or HELIUS_API_KEY)");
  }

  const all: HeliusEnrichedTx[] = [];
  let before: string | undefined;
  const pageSize = 100; // Helius max

  while (all.length < maxTxs) {
    let page: HeliusEnrichedTx[] | null = null;
    for (let attempt = 0; attempt < keys.length; attempt += 1) {
      const apiKey = keys[attempt] ?? "";
      const url = appendHeliusApiKey(`https://api.helius.xyz/v0/addresses/${mint}/transactions`, apiKey);
      const nextUrl = new URL(url);
      nextUrl.searchParams.set("limit", String(pageSize));
      if (before) nextUrl.searchParams.set("before", before);

      let response: Response;
      try {
        response = await fetch(nextUrl.toString(), { headers: { Accept: "application/json" } });
      } catch (error) {
        if (attempt < keys.length - 1) continue;
        throw new Error(`Helius fetch failed: ${(error as Error).message}`);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        if (isHeliusRetryableStatus(response.status) && attempt < keys.length - 1) continue;
        throw new Error(`Helius HTTP ${response.status}: ${body.slice(0, 200)}`);
      }

      page = (await response.json()) as HeliusEnrichedTx[];
      break;
    }

    if (!page || !Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    before = page[page.length - 1]?.signature;
    if (page.length < pageSize) break;
  }
  return all.slice(0, maxTxs);
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

  // 2. Fallback: correlate tokenTransfers + nativeTransfers
  const tokenTransfers = (tx.tokenTransfers || []).filter((t) => t.mint === mint);
  if (tokenTransfers.length === 0) return null;
  const nativeTransfers = tx.nativeTransfers || [];
  if (nativeTransfers.length === 0) return null;

  // Largest native transfer = the swap leg
  const largestNative = nativeTransfers.reduce((a, b) => (b.amount > a.amount ? b : a));
  const largestToken = tokenTransfers.reduce((a, b) => (b.tokenAmount > a.tokenAmount ? b : a));

  const amountSol = largestNative.amount / LAMPORTS_PER_SOL;
  const amountTokens = largestToken.tokenAmount;
  if (amountSol < 1e-6 || amountTokens < 1e-9) return null;

  // BUY: trader sends SOL out, receives tokens
  // SELL: trader sends tokens out, receives SOL
  const trader = tx.feePayer || largestNative.fromUserAccount || largestToken.toUserAccount || "";
  const isBuy = largestNative.fromUserAccount === trader && largestToken.toUserAccount === trader;
  const isSell = largestToken.fromUserAccount === trader && largestNative.toUserAccount === trader;

  if (!isBuy && !isSell) return null;
  return {
    signature: tx.signature,
    timestamp: tx.timestamp,
    trader,
    type: isBuy ? "buy" : "sell",
    amountSol,
    amountTokens,
    priceSol: amountSol / amountTokens,
    fee: tx.fee,
    source: tx.source,
  };
}

/**
 * Get the first transaction timestamp (account creation proxy) for a wallet.
 * Used for Fresh Wallet detection (created < 1 hour ago).
 */
export async function getWalletFirstSeen(address: string): Promise<number | null> {
  const keys = await getRuntimeHeliusApiKeys();
  if (keys.length === 0) return null;
  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    try {
      const apiKey = keys[attempt] ?? "";
      const url = new URL(appendHeliusApiKey(`https://api.helius.xyz/v0/addresses/${address}/transactions`, apiKey));
      url.searchParams.set("limit", "100");
      // Single page is enough for fresh-detection (<1h old wallets have very few txs).
      // If wallet has >100 txs, it's definitely not fresh — return earliest of this page as approximation.
      const r = await fetch(url.toString());
      if (!r.ok) {
        if (isHeliusRetryableStatus(r.status) && attempt < keys.length - 1) continue;
        return null;
      }
      const page = (await r.json()) as HeliusEnrichedTx[];
      if (!Array.isArray(page) || page.length === 0) return null;
      return Math.min(...page.map((t) => t.timestamp || Infinity));
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

  const keys = await getRuntimeHeliusApiKeys();
  const rpcCandidates = keys.map((key) => appendHeliusApiKey("https://mainnet.helius-rpc.com/", key));
  if (!rpcCandidates.includes(HELIUS_RPC)) rpcCandidates.push(HELIUS_RPC);

  // RPC supports up to 100 accounts per call
  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += 100) chunks.push(addresses.slice(i, i + 100));

  for (const chunk of chunks) {
    for (let attempt = 0; attempt < rpcCandidates.length; attempt += 1) {
      try {
        const r = await fetch(rpcCandidates[attempt], {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getMultipleAccounts",
            params: [chunk, { encoding: "base64" }],
          }),
        });
        if (!r.ok) {
          if (attempt < rpcCandidates.length - 1) continue;
          break;
        }
        const json = await r.json();
        const arr = json?.result?.value;
        if (!Array.isArray(arr)) {
          if (attempt < rpcCandidates.length - 1) continue;
          break;
        }
        chunk.forEach((addr, i) => {
          const lamports = arr[i]?.lamports;
          if (typeof lamports === "number") {
            result.set(addr, lamports / LAMPORTS_PER_SOL);
          }
        });
        break;
      } catch {
        if (attempt === rpcCandidates.length - 1) break;
      }
    }
  }
  return result;
}
