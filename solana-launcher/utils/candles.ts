// data-tag: utils.candles
// Client-side OHLCV utilities: aggregation, mock generation, time window calculations

import type { Candle, Timeframe } from "@/lib/chart/types";

/** Minutes per timeframe (sub-minute treated as 1m for base) */
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
  "1w": 1440,
  "all": 1440,
};

/** Seconds per timeframe */
export const TF_SECONDS: Record<Timeframe, number> = {
  "1s": 1,
  "5s": 5,
  "15s": 15,
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
  "1w": 86400,
  "all": 86400,
};

/**
 * Aggregate candles to a larger timeframe in a single pass (O(n)).
 * Source candles must be sorted ascending by time.
 */
export function aggregateCandles(source: Candle[], targetTf: Timeframe): Candle[] {
  const minutes = TF_MINUTES[targetTf];
  return aggregateByMinutes(source, minutes);
}

/**
 * Aggregate candles by specific minute count (flexible aggregation).
 * Source candles must be sorted ascending by time.
 */
export function aggregateByMinutes(source: Candle[], minutes: number): Candle[] {
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
      existing.close = c.close; // last candle's close wins
      existing.volume += c.volume;
    }
  }
  
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

/**
 * Generate deterministic mock candles for development/testing.
 * Same mint + timeframe will always produce same pattern.
 */
export function generateMockCandles(
  mint: string,
  timeframe: Timeframe,
  count: number,
  startPrice?: number
): Candle[] {
  const candles: Candle[] = [];
  const tfSec = TF_SECONDS[timeframe];
  // Bucket-align "now" so that successive calls (e.g. from polling) keep the
  // SAME timestamps for past candles and only append a new bucket when time
  // crosses the next boundary. Without this, every poll regenerates the full
  // array shifted by a few seconds → chart viewport drifts off-screen.
  const now = Math.floor(Date.now() / 1000 / tfSec) * tfSec;
  
  // Deterministic seed from mint string
  let seed = mint.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const random = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  
  let price = startPrice ?? (0.0001 + random() * 0.001);
  
  for (let i = count; i >= 0; i--) {
    const time = now - i * tfSec;
    const trend = (random() - 0.48) * 0.06; // Slight upward bias
    const volatility = random() * 0.015;
    
    const open = price;
    let close = price * (1 + trend);
    let high = Math.max(open, close) * (1 + volatility);
    let low = Math.min(open, close) * (1 - volatility);
    let volume = 50 + random() * 450;

    // LIVE CANDLE animation: the last (i === 0) candle is the "current bucket".
    // Add intra-bucket noise based on real wall-clock so the candle visibly
    // wiggles on every poll, even though the bucket timestamp hasn't advanced.
    if (i === 0) {
      const intra = (Date.now() % (tfSec * 1000)) / (tfSec * 1000); // 0..1 within bucket
      const wiggle = Math.sin(Date.now() / 1000) * volatility * 2;
      close = open * (1 + (close / open - 1) * intra + wiggle);
      high = Math.max(high, close, open) * (1 + volatility * 0.5);
      low = Math.min(low, close, open) * (1 - volatility * 0.5);
      volume *= 0.3 + intra; // volume builds up over the bucket
    }

    candles.push({ time, open, high, low, close, volume });
    price = close;
  }
  
  return candles;
}

/**
 * Get recommended time window (in ms) for fetching historical data per timeframe.
 * Optimized for balance between speed and usefulness.
 */
export function getTimeWindowForTf(timeframe: Timeframe): number {
  const windows: Record<Timeframe, number> = {
    "1s": 30 * 60 * 1000,           // 30 minutes
    "5s": 2 * 60 * 60 * 1000,       // 2 hours
    "15s": 6 * 60 * 60 * 1000,      // 6 hours
    "1m": 24 * 60 * 60 * 1000,      // 1 day
    "5m": 3 * 24 * 60 * 60 * 1000,  // 3 days
    "15m": 3 * 24 * 60 * 60 * 1000, // 3 days
    "1h": 7 * 24 * 60 * 60 * 1000,  // 7 days
    "4h": 7 * 24 * 60 * 60 * 1000,  // 7 days
    "1d": 30 * 24 * 60 * 60 * 1000, // 30 days
    "1w": 7 * 24 * 60 * 60 * 1000,  // 7 days
    "all": 5 * 365 * 24 * 60 * 60 * 1000, // deep available history
  };
  return windows[timeframe];
}

/**
 * Clamp candle array to visible window for performance.
 * Keeps last N candles, optionally centered around a specific time.
 */
export function clampCandles(
  candles: Candle[],
  maxVisible: number,
  centerTime?: number
): Candle[] {
  if (candles.length <= maxVisible) return candles;
  
  if (centerTime) {
    const centerIdx = candles.findIndex(c => c.time >= centerTime);
    if (centerIdx === -1) return candles.slice(-maxVisible);
    
    const halfWindow = Math.floor(maxVisible / 2);
    const start = Math.max(0, centerIdx - halfWindow);
    const end = Math.min(candles.length, centerIdx + halfWindow);
    return candles.slice(start, end);
  }
  
  return candles.slice(-maxVisible);
}

/**
 * Format price for display with appropriate precision.
 */
export function formatPrice(price: number): string {
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.01) return price.toFixed(4);
  if (price >= 0.0001) return price.toFixed(6);
  return price.toFixed(8);
}

/**
 * Calculate 24h stats from candles.
 */
export function calculate24hStats(candles: Candle[]): {
  change: number;
  volume: number;
  high: number;
  low: number;
} {
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const window = candles.filter(c => c.time >= dayAgo);
  
  if (window.length === 0) {
    return { change: 0, volume: 0, high: 0, low: 0 };
  }
  
  const first = window[0];
  const last = window[window.length - 1];
  const volume = window.reduce((s, c) => s + c.volume, 0);
  const high = window.reduce((m, c) => Math.max(m, c.high), -Infinity);
  const low = window.reduce((m, c) => Math.min(m, c.low), Infinity);
  const change = first.open > 0 ? ((last.close - first.open) / first.open) * 100 : 0;
  
  return { change, volume, high, low };
}
