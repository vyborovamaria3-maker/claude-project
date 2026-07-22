// data-tag: lib.chart.aggregator
// Aggregates raw PumpPortal trades into OHLCV candles per timeframe bucket.

import { type Candle, type Trade, type Timeframe, TF_SECONDS } from "./types";

function bucketStart(tsSec: number, tfSec: number): number {
  return Math.floor(tsSec / tfSec) * tfSec;
}

/** Extended trade with market info for filtering */
export interface TradeWithMarket extends Trade {
  marketAddress?: string;
  quoteMintAddress?: string;
  programAddress?: string;
}

export class TradeAggregator {
  private trades: TradeWithMarket[] = [];
  // candle cache per timeframe
  private cache = new Map<Timeframe, Candle[]>();
  // Market filtering state
  private excludedMarkets = new Set<string>();
  private excludedQuotes = new Set<string>();
  private marketInfo = new Map<string, { quoteMint: string; programAddress: string }>();

  addTrade(trade: Trade): void {
    this.trades.push(trade);
    // Update each cached timeframe in-place instead of clearing
    // (clearing would wipe historical candles loaded via setHistoricalCandles)
    for (const tf of Array.from(this.cache.keys())) {
      this.updateLast(tf, trade);
    }
  }

  addTrades(trades: Trade[]): void {
    this.trades.push(...trades);
    // For bulk add, fully rebuild cached timeframes from trades
    for (const tf of Array.from(this.cache.keys())) {
      this.cache.delete(tf);
    }
  }

  /** Build OHLCV candles for given timeframe from all stored trades */
  getCandles(tf: Timeframe): Candle[] {
    const cached = this.cache.get(tf);
    if (cached) return cached;

    const tfSec = TF_SECONDS[tf];
    const buckets = new Map<number, Candle>();

    for (const t of this.trades) {
      const tsSec = Math.floor(t.timestamp / 1000);
      const bucket = bucketStart(tsSec, tfSec);

      const existing = buckets.get(bucket);
      if (!existing) {
        buckets.set(bucket, {
          time: bucket,
          open: t.priceUsd,
          high: t.priceUsd,
          low: t.priceUsd,
          close: t.priceUsd,
          volume: t.solAmount,
        });
      } else {
        existing.high = Math.max(existing.high, t.priceUsd);
        existing.low = Math.min(existing.low, t.priceUsd);
        existing.close = t.priceUsd;
        existing.volume += t.solAmount;
      }
    }

    const sorted = Array.from(buckets.values()).sort((a, b) => a.time - b.time);
    this.cache.set(tf, sorted);
    return sorted;
  }

  /** Update (or insert) last candle with incoming trade — for live updates */
  updateLast(tf: Timeframe, trade: Trade): Candle[] {
    const tfSec = TF_SECONDS[tf];
    const tsSec = Math.floor(trade.timestamp / 1000);
    const bucket = bucketStart(tsSec, tfSec);

    const candles = this.getCandles(tf);
    const last = candles[candles.length - 1];

    let updated: Candle[];
    if (!last || bucket > last.time) {
      // new bucket
      const newCandle: Candle = {
        time: bucket,
        open: trade.priceUsd,
        high: trade.priceUsd,
        low: trade.priceUsd,
        close: trade.priceUsd,
        volume: trade.solAmount,
      };
      updated = [...candles, newCandle];
    } else if (bucket === last.time) {
      const updatedLast: Candle = {
        ...last,
        high: Math.max(last.high, trade.priceUsd),
        low: Math.min(last.low, trade.priceUsd),
        close: trade.priceUsd,
        volume: last.volume + trade.solAmount,
      };
      updated = [...candles.slice(0, -1), updatedLast];
    } else {
      return candles;
    }

    this.cache.set(tf, updated);
    return updated;
  }

  get24hStats(): { change: number; volume: number; high: number; low: number } {
    const since = Date.now() - 24 * 3600 * 1000;
    const recent = this.trades.filter(t => t.timestamp >= since);
    if (recent.length === 0) return { change: 0, volume: 0, high: 0, low: 0 };

    const first = recent[0].priceUsd;
    const last = recent[recent.length - 1].priceUsd;
    const volume = recent.reduce((s, t) => s + t.solAmount, 0);
    const high = Math.max(...recent.map(t => t.priceUsd));
    const low = Math.min(...recent.map(t => t.priceUsd));
    const change = first > 0 ? ((last - first) / first) * 100 : 0;

    return { change, volume, high, low };
  }

  clear(): void {
    this.trades = [];
    this.cache.clear();
  }

  /** Inject pre-built historical OHLCV for a specific timeframe (bypasses trade aggregation) */
  setHistoricalCandles(tf: Timeframe, candles: Candle[]): void {
    // sort + dedupe by time
    const dedup = new Map<number, Candle>();
    for (const c of candles) dedup.set(c.time, c);
    const sorted = Array.from(dedup.values()).sort((a, b) => a.time - b.time);
    this.cache.set(tf, sorted);
  }

  get tradeCount(): number {
    return this.trades.length;
  }

  // Market filtering methods
  setExcludedMarkets(markets: Set<string>): void {
    this.excludedMarkets = markets;
    // Clear cache to force rebuild with filters
    this.cache.clear();
  }

  setExcludedQuotes(quotes: Set<string>): void {
    this.excludedQuotes = quotes;
    this.cache.clear();
  }

  getExcludedMarkets(): Set<string> {
    return new Set(this.excludedMarkets);
  }

  getExcludedQuotes(): Set<string> {
    return new Set(this.excludedQuotes);
  }

  /** Get market statistics from stored trades */
  getMarketStats(): Array<{
    address: string;
    quoteMint: string;
    programAddress: string;
    tradeCount: number;
    volumeSol: number;
  }> {
    const stats = new Map<string, { quoteMint: string; programAddress: string; count: number; volume: number }>();
    
    for (const t of this.trades) {
      if (!t.marketAddress) continue;
      
      const existing = stats.get(t.marketAddress);
      if (existing) {
        existing.count++;
        existing.volume += t.solAmount;
      } else {
        stats.set(t.marketAddress, {
          quoteMint: t.quoteMintAddress || "",
          programAddress: t.programAddress || "",
          count: 1,
          volume: t.solAmount,
        });
      }
    }

    return Array.from(stats.entries())
      .map(([address, info]) => ({
        address,
        quoteMint: info.quoteMint,
        programAddress: info.programAddress,
        tradeCount: info.count,
        volumeSol: info.volume,
      }))
      .sort((a, b) => b.volumeSol - a.volumeSol);
  }

  /** Get quote mint statistics */
  getQuoteStats(): Array<{
    mint: string;
    symbol: string;
    tradeCount: number;
    volumeSol: number;
  }> {
    const stats = new Map<string, { count: number; volume: number }>();
    
    for (const t of this.trades) {
      if (!t.quoteMintAddress) continue;
      
      const existing = stats.get(t.quoteMintAddress);
      if (existing) {
        existing.count++;
        existing.volume += t.solAmount;
      } else {
        stats.set(t.quoteMintAddress, { count: 1, volume: t.solAmount });
      }
    }

    return Array.from(stats.entries())
      .map(([mint, info]) => ({
        mint,
        symbol: mint.slice(0, 4) + "..." + mint.slice(-4),
        tradeCount: info.count,
        volumeSol: info.volume,
      }))
      .sort((a, b) => b.volumeSol - a.volumeSol);
  }
}
