// data-tag: lib.chart.aggregate
// Client-side OHLCV aggregation: roll up smaller candles into larger timeframes.

import type { Candle, Timeframe } from "./types";

/** Minutes per timeframe (sub-minute treated as 1m for aggregation base) */
export const TF_MINUTES: Record<Timeframe, number> = {
  "1s": 1,
  "5s": 1,
  "15s": 1,
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
};

/**
 * Aggregate an array of 1m candles into N-minute candles.
 * Source candles must be sorted ascending by `time` (unix seconds).
 */
export function aggregateCandles(source: Candle[], minutes: number): Candle[] {
  if (minutes <= 1 || source.length === 0) return source;
  const bucketSec = minutes * 60;

  const buckets = new Map<number, Candle>();
  for (const c of source) {
    const bucket = Math.floor(c.time / bucketSec) * bucketSec;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, {
        time: bucket,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close; // last candle's close wins (ascending order)
      existing.volume += c.volume;
    }
  }

  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

/** Aggregate by Timeframe key (convenience wrapper). */
export function aggregateByTimeframe(source: Candle[], tf: Timeframe): Candle[] {
  return aggregateCandles(source, TF_MINUTES[tf]);
}

// Sub-minute interpolation removed for MVP - WebSocket ticks required for <1m timeframes
