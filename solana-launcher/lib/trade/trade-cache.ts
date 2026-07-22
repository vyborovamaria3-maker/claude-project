// data-tag: lib.trade.trade_cache
import type { RawTrade } from "./helius";
import { fetchMergedTradesForMint } from "./merged-trades";
import { getTokenTrades, persistTokenTrades } from "./db";

type LoadOptions = {
  maxTrades?: number;
  refresh?: boolean;
  onProgress?: (info: { fetched: number; page: number; fromCache?: boolean }) => void;
};

const inFlight = new Map<string, Promise<RawTrade[]>>();

function toRawTrade(t: ReturnType<typeof getTokenTrades>[number]): RawTrade {
  return {
    signature: t.signature,
    timestamp: t.timestamp,
    trader: t.trader,
    type: t.type,
    amountSol: t.amountSol,
    amountTokens: t.amountTokens,
    priceSol: t.priceSol,
    source: t.source,
  };
}

function cacheKey(mint: string, maxTrades: number, refresh: boolean): string {
  return `${mint}:${maxTrades}:${refresh ? "refresh" : "cached"}`;
}

export async function loadTokenTrades(
  mint: string,
  options: LoadOptions = {}
): Promise<RawTrade[]> {
  const maxTrades = options.maxTrades ?? 3_000;

  if (!options.refresh) {
    const stored = getTokenTrades(mint, maxTrades);
    if (stored.length > 0) {
      console.log(`[loadTokenTrades] mint=${mint.slice(0,8)}... cache HIT: ${stored.length} trades`);
      options.onProgress?.({ fetched: stored.length, page: 0, fromCache: true });
      return stored.map(toRawTrade);
    }
    console.log(`[loadTokenTrades] mint=${mint.slice(0,8)}... cache MISS`);
  } else {
    console.log(`[loadTokenTrades] mint=${mint.slice(0,8)}... refresh requested, skipping cache`);
  }

  const key = cacheKey(mint, maxTrades, !!options.refresh);
  const existing = inFlight.get(key);
  if (existing) {
    console.log(`[loadTokenTrades] mint=${mint.slice(0,8)}... in-flight request exists, reusing`);
    return existing;
  }

  const promise = fetchMergedTradesForMint(mint, maxTrades, options.onProgress).then((trades) => {
    console.log(`[loadTokenTrades] mint=${mint.slice(0,8)}... fetched ${trades.length} trades, persisting to DB`);
    persistTokenTrades(mint, trades.map((t) => ({
      signature: t.signature,
      timestamp: t.timestamp,
      trader: t.trader,
      type: t.type,
      amountSol: t.amountSol,
      amountTokens: t.amountTokens,
      priceSol: t.priceSol,
      source: t.source,
    })));
    return trades;
  }).finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, promise);
  return promise;
}
