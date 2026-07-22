eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjcmVhdGVkQXQiOjE3Nzk0NDk2Njk4NjgsImVtYWlsIjoicG90YXBvdmRpbWEzNTRAZ21haWwuY29tIiwiYWN0aW9uIjoidG9rZW4tYXBpIiwiYXBpVmVyc2lvbiI6InYyIiwiaWF0IjoxNzc5NDQ5NjY5fQ.N8dYxEQfrBcKKhQP3GdOFFof3DpfA9yLiFlEChj9Id4/**
 * CandleAggregator - Aggregates raw trades into OHLCV candles
 * Supports timeframes: 1s, 5s, 15s, 1m, 5m, 15m, 1h
 */

const TF_SECONDS = {
  '1s': 1,
  '5s': 5,
  '15s': 15,
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
};

const MAX_CANDLES = {
  '1s': 86400,    // 24 hours
  '5s': 17280,    // 24 hours
  '15s': 5760,    // 24 hours
  '1m': 1440,     // 24 hours
  '5m': 2016,     // 7 days
  '15m': 672,     // 7 days
  '1h': 168,      // 7 days
};

class CandleAggregator {
  constructor() {
    // Map: "mint:timeframe" -> Map<timestamp, candle>
    this.candles = new Map();
    // Map: "mint:timeframe" -> array of sorted candles (cache)
    this.sortedCache = new Map();
    this.cacheValid = new Map();
  }

  getKey(mint, timeframe) {
    return `${mint}:${timeframe}`;
  }

  getBucketTimestamp(timestamp, timeframe) {
    const tfSec = TF_SECONDS[timeframe];
    if (!tfSec) return Math.floor(timestamp / 1000);
    return Math.floor(Math.floor(timestamp / 1000) / tfSec) * tfSec;
  }

  addTrade(mint, trade) {
    const { timestamp, solAmount, tokenAmount, isBuy } = trade;
    
    // Calculate price from solAmount/tokenAmount
    const price = tokenAmount > 0 ? solAmount / tokenAmount : 0;
    const volume = tokenAmount;

    for (const timeframe of Object.keys(TF_SECONDS)) {
      const key = this.getKey(mint, timeframe);
      const bucketTs = this.getBucketTimestamp(timestamp, timeframe);

      if (!this.candles.has(key)) {
        this.candles.set(key, new Map());
      }

      const timeframeCandles = this.candles.get(key);

      if (timeframeCandles.has(bucketTs)) {
        const candle = timeframeCandles.get(bucketTs);
        candle.high = Math.max(candle.high, price);
        candle.low = Math.min(candle.low, price);
        candle.close = price;
        candle.volume += volume;
      } else {
        timeframeCandles.set(bucketTs, {
          time: bucketTs,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: volume,
        });
      }

      // Invalidate cache
      this.cacheValid.set(key, false);

      // Cleanup old candles
      this.cleanupOldCandles(key, timeframe);
    }
  }

  cleanupOldCandles(key, timeframe) {
    const maxCount = MAX_CANDLES[timeframe];
    const candlesMap = this.candles.get(key);
    if (!candlesMap || candlesMap.size <= maxCount) return;

    const sortedKeys = Array.from(candlesMap.keys()).sort((a, b) => a - b);
    const toDelete = sortedKeys.slice(0, sortedKeys.length - maxCount);
    for (const ts of toDelete) {
      candlesMap.delete(ts);
    }
    this.cacheValid.set(key, false);
  }

  getCandles(mint, timeframe) {
    const key = this.getKey(mint, timeframe);
    
    if (this.cacheValid.get(key)) {
      return this.sortedCache.get(key) || [];
    }

    const candlesMap = this.candles.get(key);
    if (!candlesMap) return [];

    const sorted = Array.from(candlesMap.values())
      .sort((a, b) => a.time - b.time);

    this.sortedCache.set(key, sorted);
    this.cacheValid.set(key, true);
    return sorted;
  }

  getLastCandle(mint, timeframe) {
    const candles = this.getCandles(mint, timeframe);
    return candles.length > 0 ? candles[candles.length - 1] : null;
  }

  clearMint(mint) {
    for (const timeframe of Object.keys(TF_SECONDS)) {
      const key = this.getKey(mint, timeframe);
      this.candles.delete(key);
      this.sortedCache.delete(key);
      this.cacheValid.delete(key);
    }
  }

  getStats(mint, timeframe) {
    const candles = this.getCandles(mint, timeframe);
    if (candles.length === 0) {
      return { price: 0, change24h: 0, volume24h: 0, high24h: 0, low24h: 0 };
    }

    const lastCandle = candles[candles.length - 1];
    const price = lastCandle.close;

    // 24h window
    const now = Math.floor(Date.now() / 1000);
    const dayAgo = now - 86400;
    const last24h = candles.filter(c => c.time >= dayAgo);
    
    const window = last24h.length > 0 ? last24h : candles.slice(-100);
    
    const first = window[0];
    const last = window[window.length - 1];
    const high = window.reduce((m, c) => Math.max(m, c.high), -Infinity);
    const low = window.reduce((m, c) => Math.min(m, c.low), Infinity);
    const volume24h = window.reduce((s, c) => s + c.volume, 0);
    const change24h = first.open > 0 ? ((last.close - first.open) / first.open) * 100 : 0;

    return { price, change24h, volume24h, high24h: high, low24h: low };
  }
}

module.exports = { CandleAggregator, TF_SECONDS };
