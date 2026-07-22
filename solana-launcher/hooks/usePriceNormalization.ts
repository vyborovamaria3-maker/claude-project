"use client";
// data-tag: hooks.use_price_normalization
// Price normalization via DexScreener - separated from PumpFunChart

import { useState, useEffect, useMemo } from "react";
import type { Candle } from "@/lib/chart/types";

interface UsePriceNormalizationOptions {
  mint: string;
  candles: Candle[];
  enabled?: boolean;
  refreshInterval?: number;
}

interface UsePriceNormalizationReturn {
  realPrice: number | null;
  normalizedCandles: Candle[];
  isLoading: boolean;
  error: string | null;
  lastUpdate: number | null;
}

export function usePriceNormalization({
  mint,
  candles,
  enabled = true,
  refreshInterval = 10000 // 10 seconds
}: UsePriceNormalizationOptions): UsePriceNormalizationReturn {
  const [realPrice, setRealPrice] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  // Fetch real price from DexScreener via our API
  useEffect(() => {
    if (!mint || !enabled) return;

    const fetchPrice = async () => {
      setIsLoading(true);
      try {
        const res = await fetch(
          `/api/token-ohlcv?mint=${encodeURIComponent(mint)}&_=${Date.now()}`,
          { cache: "no-store" }
        );

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        if (data.pair?.priceUsd) {
          setRealPrice(data.pair.priceUsd);
          setLastUpdate(Date.now());
          setError(null);
        } else {
          throw new Error("No price data available");
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setIsLoading(false);
      }
    };

    // Initial fetch
    fetchPrice();

    // Polling
    const timer = setInterval(fetchPrice, refreshInterval);
    return () => clearInterval(timer);
  }, [mint, enabled, refreshInterval]);

  // Normalize candles
  const normalizedCandles = useMemo(() => {
    if (!candles.length || !realPrice) return candles;

    const lastCandlePrice = candles[candles.length - 1]?.close;
    if (!lastCandlePrice) return candles;

    // Check if prices match within 0.5% - no normalization needed
    const diff = Math.abs(lastCandlePrice - realPrice) / realPrice;
    if (diff < 0.005) return candles;

    // Calculate normalization factor
    const factor = realPrice / lastCandlePrice;

    return candles.map(c => ({
      ...c,
      open: c.open * factor,
      high: c.high * factor,
      low: c.low * factor,
      close: c.close * factor,
    }));
  }, [candles, realPrice]);

  return {
    realPrice,
    normalizedCandles,
    isLoading,
    error,
    lastUpdate
  };
}
