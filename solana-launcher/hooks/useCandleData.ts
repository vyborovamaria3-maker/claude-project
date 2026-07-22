"use client";
// data-tag: hooks.use_candle_data
// Simplified candle data hook using unified CandleStore

import { useEffect, useCallback, useRef, useMemo } from "react";
import { useCandleStore } from "@/stores/candleStore";
import type { Candle, Timeframe, Trade } from "@/lib/chart/types";

const POLLING_INTERVAL = 3000; // 3s for minute+ - real-time with reasonable API pressure
const SUBSECOND_INTERVAL = 1000; // 1s for sub-second - true real-time

interface UseCandleDataOptions {
  mint: string;
  timeframe: Timeframe;
  enabled?: boolean;
  includeLiveCandle?: boolean;
  pollHistory?: boolean;
}

export function useCandleData({ mint, timeframe, enabled = true, includeLiveCandle = true, pollHistory = true }: UseCandleDataOptions) {
  // Subscribe to store
  const candles = useCandleStore((state) => state.candles);
  const liveCandle = useCandleStore((state) => state.liveCandle);
  const isLoading = useCandleStore((state) => state.isLoading);
  const isOnline = useCandleStore((state) => state.isOnline);
  const error = useCandleStore((state) => state.error);
  const dataSource = useCandleStore((state) => state.dataSource);


  const abortRef = useRef<AbortController | null>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const mergeIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const mintRef = useRef(mint);
  mintRef.current = mint;
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const fetchCandlesRef = useRef<((force?: boolean) => Promise<void>) | null>(null);
  const requestSeqRef = useRef(0);

  // Fetch candles from API — uses refs so callback is stable across tf/mint changes
  const fetchCandles = useCallback(async (force = false) => {
    const currentMint = mintRef.current;
    const currentTf = timeframeRef.current;
    if (!currentMint || !enabledRef.current) return;

    // Cancel previous request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestSeq = ++requestSeqRef.current;

    // Show loading spinner only on first load (no existing candles)
    const hasCandles = useCandleStore.getState().candles.length > 0;
    if (!force && !hasCandles) useCandleStore.getState().setLoading(true);

    try {
      const res = await fetch(
        `/api/token-history?mint=${encodeURIComponent(currentMint)}&tf=${currentTf}`,
        { signal: controller.signal, cache: "no-store" }
      );

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (controller.signal.aborted || requestSeq !== requestSeqRef.current) return;

      if (!Array.isArray(data.candles)) {
        throw new Error("Invalid response format");
      }

      // API already handles Market Cap to Price conversion in token-history route
      const byTime = new Map<number, Candle>();
      for (const c of data.candles) {
        if (!Number.isFinite(c?.time)) continue;
        byTime.set(c.time, {
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume
        });
      }
      const processed = Array.from(byTime.values()).sort((a, b) => a.time - b.time);

      useCandleStore.getState().setCandles(processed, data.source || "pumpfun");

      // Calculate 24h metrics
      const now = Math.floor(Date.now() / 1000);
      const dayAgo = now - 86400;
      const dayCandles = processed.filter((c: any) => c.time >= dayAgo);
      const win = dayCandles.length > 0 ? dayCandles : processed;

      if (win.length > 0) {
        const first = win[0];
        const last = win[win.length - 1];
        let high = -Infinity, low = Infinity;
        for (const c of win) { if (c.high > high) high = c.high; if (c.low < low) low = c.low; }
        const volume = win.reduce((s: number, c: any) => s + c.volume, 0);
        const change = first.open > 0 ? ((last.close - first.open) / first.open) * 100 : 0;

        useCandleStore.getState().updateMetrics({ change24h: change, volume24h: volume, high24h: high, low24h: low, lastPrice: last.close });
      }

      useCandleStore.getState().setWsStatus("polling");
      useCandleStore.getState().setError(null);
    } catch (err) {
      if ((err as Error).name !== "AbortError" && requestSeq === requestSeqRef.current) {
        useCandleStore.getState().setError((err as Error).message || "Failed to load candles");
      }
    } finally {
      if (requestSeq === requestSeqRef.current) {
        useCandleStore.getState().setLoading(false);
      }
    }
  }, []); // fully stable — all store calls via getState()

  // Keep ref to fetchCandles always current
  fetchCandlesRef.current = fetchCandles;

  // Restart polling ONLY when mint or timeframe changes
  useEffect(() => {
    if (!enabled) return;

    // Stop everything immediately
    abortRef.current?.abort();
    requestSeqRef.current += 1;
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
    if (mergeIntervalRef.current) { clearInterval(mergeIntervalRef.current); mergeIntervalRef.current = null; }

    if (useCandleStore.getState().timeframe !== timeframe) {
      useCandleStore.getState().setTimeframe(timeframe);
    }
    useCandleStore.getState().setLoading(true);

    // Fetch fresh data
    fetchCandlesRef.current?.();

    if (pollHistory) {
      const isSubSecond = ["1s", "5s", "15s"].includes(timeframe);
      const interval = isSubSecond ? SUBSECOND_INTERVAL : POLLING_INTERVAL;
      pollingRef.current = setInterval(() => fetchCandlesRef.current?.(true), interval);
    }
    // No merge interval - trades update candles directly for instant real-time

    return () => {
      abortRef.current?.abort();
      if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
      if (mergeIntervalRef.current) { clearInterval(mergeIntervalRef.current); mergeIntervalRef.current = null; }
    };
  }, [mint, timeframe, enabled, pollHistory]); // stable deps only — no store functions

  // Ingest trade from WebSocket/polling
  const ingestTrade = useCallback((trade: Trade) => {
    useCandleStore.getState().addTrade(trade);
  }, []);

  // Retry function
  const retry = useCallback(() => {
    useCandleStore.getState().setError(null);
    fetchCandlesRef.current?.();
  }, []);

  // Computed: display candles (including live candle)
  const displayCandles = useMemo(() => {
    if (!includeLiveCandle) return candles;
    if (!liveCandle) return candles;
    const last = candles[candles.length - 1];
    if (last && last.time === liveCandle.time) {
      return [...candles.slice(0, -1), liveCandle];
    }
    if (!last || liveCandle.time > last.time) {
      return [...candles, liveCandle];
    }
    return candles;
  }, [candles, liveCandle, includeLiveCandle]);

  return {
    candles: displayCandles,
    historicalCandles: candles,
    liveCandle,
    isLoading,
    isOnline,
    error,
    dataSource,
    ingestTrade,
    retry
  };
}
