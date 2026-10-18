// data-tag: lib.trade.trade_cache
import type { RawTrade } from "./helius";
import { fetchMergedTradesForMint } from "./merged-trades";
import {
  getTokenTrades,
  getTokenTradeLastCheckedAt,
  markTokenTradeChecked,
  persistTokenTrades,
} from "./db";

type LoadOptions = {
  maxTrades?: number;
  refresh?: boolean;
  onProgress?: (info: { fetched: number; page: number; fromCache?: boolean }) => void;
};

const TRADE_SYNC_TTL_MS = (() => {
  const value = Number(process.env.CHAIN_TRADE_SYNC_TTL_MS || 60_000);
  return Number.isFinite(value) ? Math.max(10_000, Math.min(600_000, Math.floor(value))) : 60_000;
})();

const inFlight = new Map<string, Promise<RawTrade[]>>();

function toRawTrade(t: ReturnType<typeof getTokenTrades>[number]): RawTrade {
  return {
    signature: t.signature,
    timestamp: t.timestamp,
    slot: t.slot ?? undefined,
    trader: t.trader,
    type: t.type,
    amountSol: t.amountSol,
    amountTokens: t.amountTokens,
    priceSol: t.priceSol,
    quoteMint: t.quoteMint ?? undefined,
    quoteAmount: t.quoteAmount ?? undefined,
    quoteDecimals: t.quoteDecimals ?? undefined,
    quoteUsdValue: t.quoteUsdValue ?? undefined,
    fee: t.fee ?? undefined,
    jitoTipLamports: t.jitoTipLamports ?? undefined,
    source: t.source ?? undefined,
  };
}

export async function loadTokenTrades(
  mint: string,
  options: LoadOptions = {},
): Promise<RawTrade[]> {
  const maxTrades = options.maxTrades ?? 3_000;
  if (!Number.isInteger(maxTrades) || maxTrades < 1) throw new Error("maxTrades must be a positive integer");
  const stored = getTokenTrades(mint, maxTrades);
  const lastChecked = getTokenTradeLastCheckedAt(mint);
  const recentCheck = lastChecked != null && Date.now() - lastChecked < TRADE_SYNC_TTL_MS;
  if (!options.refresh && recentCheck) {
    options.onProgress?.({ fetched: stored.length, page: 0, fromCache: true });
    return stored.map(toRawTrade);
  }

  // Concurrent ordinary/refresh callers share the same network work per mint.
  const key = `${mint}:${maxTrades}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const knownSignatures = new Set(stored.map((trade) => trade.signature));
  const work = (async () => {
    try {
      // Incremental Helius fetch stops on the first persisted signature,
      // instead of replaying thousands of already-known transactions.
      const newTrades = await fetchMergedTradesForMint(
        mint, maxTrades, options.onProgress, knownSignatures,
      );
      if (newTrades.length > 0) {
        persistTokenTrades(mint, newTrades.map((t) => ({
          signature: t.signature,
          timestamp: t.timestamp,
          trader: t.trader,
          type: t.type,
          amountSol: t.amountSol,
          amountTokens: t.amountTokens,
          priceSol: t.priceSol,
          quoteMint: t.quoteMint,
          quoteAmount: t.quoteAmount,
          quoteDecimals: t.quoteDecimals,
          quoteUsdValue: t.quoteUsdValue,
          slot: t.slot,
          fee: t.fee,
          jitoTipLamports: t.jitoTipLamports,
          source: t.source,
        })));
      }
      // Mark even an empty successful scan, so idle tokens do not poll API
      // on every page view. Refresh bypasses this freshness check.
      markTokenTradeChecked(mint);
      return getTokenTrades(mint, maxTrades).map(toRawTrade);
    } catch (error) {
      if (!stored.length) throw error;
      console.warn("[loadTokenTrades] provider unavailable; returning stale persisted history", error);
      options.onProgress?.({ fetched: stored.length, page: 0, fromCache: true });
      return stored.map(toRawTrade);
    }
  })().finally(() => {
    if (inFlight.get(key) === work) inFlight.delete(key);
  });
  inFlight.set(key, work);
  return work;
}
