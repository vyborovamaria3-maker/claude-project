"use client";
// data-tag: hooks.use_ohlcv

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { TradeAggregator } from "@/lib/chart/aggregator";
import { aggregateByTimeframe } from "@/lib/chart/aggregate";
import {
  type Candle,
  type Trade,
  type Timeframe,
  type OHLCVState,
  type WsStatus,
} from "@/lib/chart/types";
import { generateMockCandles, calculate24hStats } from "@/utils/candles";

// Helius WebSocket REMOVED — free-tier key spams console with failed connection errors.
// Historical refreshes are deliberately slower than realtime trade ingestion:
// 10s for minute+ TFs and 1s for sub-minute safety refreshes.
const CACHE_TTL = 5 * 60_000; // 5 minutes — history rarely changes; live updates handled via polling
const CACHE_FRESH = 1_000;   // <1s old = serve from cache, no background refetch
const POLLING_INTERVAL = 10_000; // 10s polling for 1m+ TFs (live trades patch chart in between)
const SUB_MINUTE_POLLING_INTERVAL = 1_000; // PumpPortal/live trades handle realtime movement between refreshes

// Per-TF candle display caps — keeps the chart light & smooth
const CANDLE_LIMIT: Record<string, number> = {
  "1s": 86400,   // 24h
  "5s": 51840,   // 3 days
  "15s": 40320,  // 7 days
  "1m": 5000,    // ~3.5 days
  "5m": 5000,    // ~17 days
  "15m": 5000,   // ~52 days
  "1h": 5000,    // ~7 months
  "4h": 3000,    // ~1.4 years
  "1d": 1500,    // ~4 years
};
function capCandles(c: Candle[], tf: Timeframe): Candle[] {
  const lim = CANDLE_LIMIT[tf] ?? 120;
  return c.length > lim ? c.slice(c.length - lim) : c;
}

function isMockEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const sp = new URLSearchParams(window.location.search);
  if (sp.get("real") === "true") return false; // explicit override
  return sp.get("mock") === "true";
}

// Global per-mint aggregators (survive re-renders / timeframe switches)
const aggregators = new Map<string, TradeAggregator>();

// Client-side cache: mint-tf -> { candles, stats, timestamp }
interface CacheEntry {
  candles: Candle[];
  stats: { change: number; volume: number; high: number; low: number; lastPrice: number };
  timestamp: number;
}
const globalCache = new Map<string, CacheEntry>();

function getAggregator(mint: string): TradeAggregator {
  if (!aggregators.has(mint)) aggregators.set(mint, new TradeAggregator());
  return aggregators.get(mint)!;
}

function getCacheKey(mint: string, tf: Timeframe): string {
  return `${mint}-${tf}`;
}

function getCached(mint: string, tf: Timeframe): CacheEntry | null {
  const key = getCacheKey(mint, tf);
  const entry = globalCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    globalCache.delete(key);
    return null;
  }
  return entry;
}

function setCached(mint: string, tf: Timeframe, candles: Candle[], stats: CacheEntry['stats']): void {
  const key = getCacheKey(mint, tf);
  globalCache.set(key, { candles, stats, timestamp: Date.now() });
}

// SOL/USD conversion cache
const solUsdCache = new Map<string, number>(); // mint → SOL price in USD

export function useOHLCV(mint: string, timeframe: Timeframe): OHLCVState {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [wsStatus, setWsStatus] = useState<WsStatus>("connecting");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ change: 0, volume: 0, high: 0, low: 0, lastPrice: 0 });
  const [dataSource, setDataSource] = useState<OHLCVState["dataSource"]>("unknown");

  const solToUsdRef = useRef<number>(0);
  const rafRef = useRef<number>(0);
  const pendingUpdate = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const candlesLoadedRef = useRef(false);

  const agg = useMemo(() => getAggregator(mint), [mint]);

  // Reset state when mint changes
  useEffect(() => {
    setCandles([]);
    setStats({ change: 0, volume: 0, high: 0, low: 0, lastPrice: 0 });
    setIsLoading(true);
    setError(null);
    candlesLoadedRef.current = false;
    // Clear aggregator for this mint
    aggregators.delete(mint);
  }, [mint]);

  // RAF-throttled candle push with client-side aggregation
  const scheduleUpdate = useCallback(() => {
    if (pendingUpdate.current) return;
    pendingUpdate.current = true;
    rafRef.current = requestAnimationFrame(() => {
      pendingUpdate.current = false;
      
      let c: Candle[];
      const isSubSec = timeframe === "1s" || timeframe === "5s" || timeframe === "15s";
      
      if (isSubSec) {
        c = agg.getCandles(timeframe);
      } else if (timeframe === "1m") {
        c = agg.getCandles("1m");
      } else {
        // Prefer native target-tf cache (mock or future native API fetch);
        // fall back to client-side aggregation from 1m only if target cache empty.
        const direct = agg.getCandles(timeframe);
        c = direct.length > 0 ? direct : aggregateByTimeframe(agg.getCandles("1m"), timeframe);
      }
      const capped = c.length ? capCandles(c, timeframe) : [];
      setCandles(capped);

      if (c.length === 0) {
        setStats({ change: 0, volume: 0, high: 0, low: 0, lastPrice: 0 });
        return;
      }

      // 24h window in candle space (use capped for stats too)
      const nowSec = Math.floor(Date.now() / 1000);
      const since = nowSec - 86_400;
      const last24 = capped.filter(x => x.time >= since);
      const window = last24.length > 0 ? last24 : capped;
      if (window.length === 0) return;

      const first = window[0];
      const last = window[window.length - 1];
      const high = window.reduce((m, x) => Math.max(m, x.high), -Infinity);
      const low = window.reduce((m, x) => Math.min(m, x.low), Infinity);
      const volume = window.reduce((s, x) => s + x.volume, 0);
      const change = first.open > 0 ? ((last.close - first.open) / first.open) * 100 : 0;

      setStats({ change, volume, high, low, lastPrice: last.close });
    });
  }, [agg, timeframe]);

  // Fetch full historical OHLCV from API with AbortController support
  const fetchHistory = useCallback(async (tf: Timeframe, abortSignal?: AbortSignal, force?: boolean) => {
    if (!mint) return false;
    
    // Mock mode: OFF by default. Enable via ?mock=true in URL.
    const isMockMode = isMockEnabled();
    
    // Check cache first (skip when force=true, e.g. live polling)
    const cached = !force ? getCached(mint, tf) : null;
    if (cached && !abortSignal?.aborted) {
      setCandles(cached.candles);
      setStats(cached.stats);
      setIsLoading(false);
      // Don't change dataSource if using cache
      // Still fetch fresh data in background if cache is stale
      if (Date.now() - cached.timestamp < CACHE_FRESH) {
        return true; // Cache is fresh, skip background fetch
      }
    }
    
    // Determine if this is a sub-second timeframe
    const isSubSec = tf === "1s" || tf === "5s" || tf === "15s";
    
    // Mock mode: generate AT THE TARGET TF directly and store under that key.
    // Previously we always seeded 1m base and let scheduleUpdate aggregate;
    // that broke higher TFs (200 × 1m = 3.3h → 0 daily / ~1 hourly bars).
    if (isMockMode) {
      const mockCandles = generateMockCandles(mint, tf, 200);
      const mockStats = calculate24hStats(mockCandles);
      agg.setHistoricalCandles(tf, mockCandles);
      setCached(mint, tf, mockCandles, { ...mockStats, lastPrice: mockCandles[mockCandles.length - 1]?.close ?? 0 });
      setDataSource("mock");
      scheduleUpdate();
      setIsLoading(false);
      return true;
    }
    
    // Fetch the target TF directly from API (pump.fun supports 1m/5m/15m/1h/4h natively).
    // Only sub-second TFs need special handling.
    const apiTf = tf;
    
    try {
      const r = await fetch(
        `/api/token-history?mint=${encodeURIComponent(mint)}&tf=${apiTf}`,
        { 
          cache: "no-store",
          signal: abortSignal,
        }
      );
      
      if (abortSignal?.aborted) return false;
      
      const data = await r.json();
      if (!r.ok || !Array.isArray(data.candles) || data.candles.length === 0) {
        // No silent mock fallback — surface failure so user knows real data isn't available.
        return false;
      }
      
      // Set data source based on API response
      if (data.mock) {
        setDataSource("mock");
      } else if (data.source === "pumpfun") {
        setDataSource("pumpfun" as OHLCVState["dataSource"]);
      } else if (data.source === "bitquery" || data.source === "bitquery_raw") {
        setDataSource("bitquery");
      } else if (data.source === "geckoterminal") {
        setDataSource("geckoterminal");
      }

      const fetchedCandles: Candle[] = data.candles.map((c: Candle) => {
        // If close > 1, it's Market Cap (price × 1B), convert back to price
        const needsConversion = c.close > 1;
        return {
          time: c.time,
          open: needsConversion ? c.open / 1_000_000_000 : c.open,
          high: needsConversion ? c.high / 1_000_000_000 : c.high,
          low: needsConversion ? c.low / 1_000_000_000 : c.low,
          close: needsConversion ? c.close / 1_000_000_000 : c.close,
          volume: c.volume,
        };
      });
      
      
      // MERGE strategy: when polling for live updates (force=true), the server's
      // last candle may be older/staler than what PumpPortal trade stream gave us.
      // Three cases:
      //  1. ourLast.time > theirLast.time: we have a NEWER bucket (PumpPortal advanced first) → append ours
      //  2. ourLast.time === theirLast.time: same bucket → keep version with HIGHER volume (more trades baked in)
      //  3. ourLast.time < theirLast.time: server is ahead → take theirs (default)
      const baseTf = tf;
      const existing = agg.getCandles(baseTf);
      let merged = fetchedCandles;
      if (force && existing.length > 0 && fetchedCandles.length > 0) {
        const ourLast = existing[existing.length - 1];
        const theirLast = fetchedCandles[fetchedCandles.length - 1];
        if (ourLast.time > theirLast.time) {
          // We have a newer bucket — append it
          merged = [...fetchedCandles, ourLast];
        } else if (ourLast.time === theirLast.time && ourLast.volume > theirLast.volume) {
          // Same bucket, ours has more accumulated trades — preserve it
          merged = [...fetchedCandles.slice(0, -1), ourLast];
        }
      }
      agg.setHistoricalCandles(baseTf, merged);
      const newStats = calculate24hStats(merged);
      const lastPrice = merged[merged.length - 1]?.close ?? 0;
      setCached(mint, baseTf, merged, { ...newStats, lastPrice });
      
      if (!abortSignal?.aborted) {
        scheduleUpdate();
      }
      return true;
    } catch (e) {
      if ((e as Error).name === "AbortError") return false;
      return false;
    }
  }, [mint, agg, scheduleUpdate]);

  // Fetch SOL/USD + initial pair info from our proxy
  const fetchSnapshot = useCallback(async () => {
    if (!mint) return;
    try {
      const r = await fetch(`/api/token-ohlcv?mint=${encodeURIComponent(mint)}`, { cache: "no-store" });
      const data = await r.json();
      if (!r.ok || data.error === "no_pairs") {
        // Token may be very new — not on DexScreener yet, keep solToUsd=0
        setIsLoading(false);
        return;
      }
      if (data.pair) {
        const p = data.pair;
        const solUsd = p.priceNative && p.priceUsd ? p.priceUsd / p.priceNative : 0;
        solToUsdRef.current = solUsd;
        solUsdCache.set(mint, solUsd);
        // Seed a single candle ONLY if no candles AND no trades exist (first load).
        // If historical candles already loaded via setHistoricalCandles, skip — addTrade would clear cache.
        // Check only 1m base candles (all other timeframes are aggregated from 1m)
        const hasAnyCandles = agg.getCandles("1m").length > 0;
        if (p.priceUsd && agg.tradeCount === 0 && !hasAnyCandles) {
          const now = Date.now();
          agg.addTrade({
            mint,
            solAmount: 0,
            tokenAmount: 1,
            isBuy: true,
            timestamp: now,
            priceUsd: p.priceUsd,
          });
          scheduleUpdate();
        }
      }
      setError(null);
    } catch {
      // non-fatal
    } finally {
      setIsLoading(false);
    }
  }, [mint, agg, scheduleUpdate]);

  // No WebSocket — chart runs in pure polling mode.
  // wsStatus is initialized to "polling" and stays there.
  useEffect(() => {
    setWsStatus("polling");
  }, []);

  // On mint or timeframe change — load real historical candles
  useEffect(() => {
    if (!mint) return;
    setIsLoading(true);
    setError(null);
    
    // Cancel any pending requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    const { signal } = abortControllerRef.current;

    // Always clear candles immediately so previous tf data doesn't linger
    setCandles([]);
    candlesLoadedRef.current = false;

    // Check cache for instant display
    const cached = getCached(mint, timeframe);
    if (cached) {
      setCandles(cached.candles);
      setStats(cached.stats);
      setIsLoading(false);
      candlesLoadedRef.current = cached.candles.length > 0;
      if (agg.getCandles(timeframe).length === 0) {
        agg.setHistoricalCandles(timeframe, cached.candles);
      }
      scheduleUpdate();
    }

    // Kick off both requests in PARALLEL — they're independent.
    // Whichever finishes first updates the chart; we wait for history to clear loading state.
    fetchSnapshot().catch(() => {});
    (async () => {
      const ok = await fetchHistory(timeframe, signal);
      if (signal.aborted) return;
      if (ok) candlesLoadedRef.current = true;
      if (!signal.aborted && (ok || cached)) setIsLoading(false);
    })();

    // 12-second safety net: if neither history nor live trades arrived, show user-visible error
    // (mock fallback removed - was overwriting real data on slow networks)
    const fallbackTimer = setTimeout(() => {
      if (signal.aborted) return;
      if (candlesLoadedRef.current) return;
      setIsLoading(false);
      setError("Не удалось загрузить историю свечей");
    }, 12000);

    return () => {
      abortControllerRef.current?.abort();
      clearTimeout(fallbackTimer);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      pendingUpdate.current = false;
    };
    // Intentionally exclude candles.length to prevent re-fetch loop on every state update
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mint, timeframe, fetchHistory, fetchSnapshot, scheduleUpdate, agg]);

  // Polling for minute+ TFs (10s interval per spec).
  // Sub-minute TFs use their own 1s safety loop below.
  useEffect(() => {
    if (!mint) return;
    const isSubSec = timeframe === "1s" || timeframe === "5s" || timeframe === "15s";
    if (isSubSec) return;
    const interval = setInterval(() => {
      fetchHistory(timeframe, undefined, true);
    }, POLLING_INTERVAL);
    return () => clearInterval(interval);
  }, [mint, timeframe, fetchHistory]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
      abortControllerRef.current?.abort();
    };
  }, []);

  // Sub-minute history safety polling (1s/5s/15s).
  // PumpPortal/live trade ingestion provides realtime ticks; this refresh only
  // reconciles historical candles when the stream or upstream aggregation lags.
  useEffect(() => {
    if (!mint) return;
    const isSubMin = timeframe === "1s" || timeframe === "5s" || timeframe === "15s";
    if (!isSubMin) return;
    const interval = setInterval(() => {
      fetchHistory(timeframe, undefined, true); // force=true: bypass client cache
    }, SUB_MINUTE_POLLING_INTERVAL);
    return () => clearInterval(interval);
  }, [mint, timeframe, fetchHistory]);

  const retry = useCallback(() => {
    setError(null);
    globalCache.delete(getCacheKey(mint, timeframe));
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
    fetchHistory(timeframe);
    fetchSnapshot();
  }, [fetchHistory, fetchSnapshot, mint, timeframe]);

  const ingestTrade = useCallback((trade: Trade) => {
    agg.addTrade(trade);
    scheduleUpdate();
    // Also update lastPrice immediately for the header
    setStats(prev => ({ ...prev, lastPrice: trade.priceUsd || prev.lastPrice }));
  }, [agg, scheduleUpdate]);

  return {
    candles,
    timeframe,
    lastPrice: stats.lastPrice,
    change24h: stats.change,
    volume24h: stats.volume,
    high24h: stats.high,
    low24h: stats.low,
    isLoading,
    isOnline: wsStatus === "live" || wsStatus === "polling",
    wsStatus,
    dataSource,
    error,
    ingestTrade,
    retry,
  };
}
