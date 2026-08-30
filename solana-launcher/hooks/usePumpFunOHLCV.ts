"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// data-tag: hook.use_pumpfun_ohlcv

export type Timeframe = "1s" | "5s" | "15s" | "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export type Candle = {
  time: number;   // unix seconds (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type ConnectionStatus = "connecting" | "live" | "polling" | "error" | "idle";

type PairInfo = {
  dexId: string;
  pairAddress: string;
  symbol: string;
  name: string;
  priceUsd: number | null;
  priceNative: number | null;
  fdv: number | null;
  marketCap: number | null;
  volumeH24: number;
  change24h: number;
  liquidityUsd: number;
  createdAt: number | null;
};

const TF_SECONDS: Record<Timeframe, number> = {
  "1s": 1,
  "5s": 5,
  "15s": 15,
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

// In-memory cache by mint+tf
const cache = new Map<string, Candle[]>();

function bucketStart(tsSec: number, tfSec: number) {
  return Math.floor(tsSec / tfSec) * tfSec;
}

/** Synthesize "history" candles from current snapshot (DexScreener doesn't expose raw OHLCV).
 *  We seed N bars at flat current price so chart isn't empty before live data arrives. */
function seedCandles(price: number, tfSec: number, count = 60): Candle[] {
  const now = Math.floor(Date.now() / 1000);
  const start = bucketStart(now, tfSec) - tfSec * (count - 1);
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const t = start + i * tfSec;
    out.push({ time: t, open: price, high: price, low: price, close: price, volume: 0 });
  }
  return out;
}

export function usePumpFunOHLCV(mint: string, timeframe: Timeframe) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [pair, setPair] = useState<PairInfo | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempt = useRef(0);
  const lastPriceRef = useRef<number>(0);
  const seenSigsRef = useRef<Set<string>>(new Set());

  /** Append/update last candle with new tick */
  const applyTick = useCallback((priceUsd: number, volumeDelta = 0, tsMs = Date.now()) => {
    if (!priceUsd || !isFinite(priceUsd)) return;
    lastPriceRef.current = priceUsd;
    const tfSec = TF_SECONDS[timeframe];
    const now = Math.floor(tsMs / 1000);
    const bucket = bucketStart(now, tfSec);

    setCandles(prev => {
      if (prev.length === 0) {
        const seeded: Candle = {
          time: bucket,
          open: priceUsd,
          high: priceUsd,
          low: priceUsd,
          close: priceUsd,
          volume: volumeDelta,
        };
        const arr = [seeded];
        cache.set(`${mint}:${timeframe}`, arr);
        return arr;
      }
      const last = prev[prev.length - 1];
      if (bucket < last.time) return prev;
      // new bucket
      if (bucket > last.time) {
        const next: Candle = {
          time: bucket,
          open: last.close,
          high: Math.max(last.close, priceUsd),
          low: Math.min(last.close, priceUsd),
          close: priceUsd,
          volume: volumeDelta,
        };
        const arr = [...prev, next];
        cache.set(`${mint}:${timeframe}`, arr);
        return arr;
      }
      // update current bucket
      const updated: Candle = {
        ...last,
        high: Math.max(last.high, priceUsd),
        low: Math.min(last.low, priceUsd),
        close: priceUsd,
        volume: last.volume + volumeDelta,
      };
      const arr = [...prev.slice(0, -1), updated];
      cache.set(`${mint}:${timeframe}`, arr);
      return arr;
    });
  }, [mint, timeframe]);

  /** Fetch latest pair snapshot from server proxy (metadata + fallback seed price) */
  const fetchPairSnapshot = useCallback(async (seedIfEmpty: boolean) => {
    try {
      const r = await fetch(`/api/token-ohlcv?mint=${encodeURIComponent(mint)}`, { cache: "no-store" });
      const data = await r.json();
      if (!r.ok || data.error) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      const p: PairInfo = data.pair;
      setPair(p);
      setError(null);

      if (p.priceUsd) {
        if (seedIfEmpty) {
          const tfSec = TF_SECONDS[timeframe];
          const cached = cache.get(`${mint}:${timeframe}`);
          if (cached && cached.length) {
            setCandles(cached);
          } else {
            const seeded = seedCandles(p.priceUsd, tfSec, 60);
            cache.set(`${mint}:${timeframe}`, seeded);
            setCandles(seeded);
          }
        }
        applyTick(p.priceUsd, 0);
      }
    } catch (e: any) {
      setError(e?.message ?? "fetch_failed");
      setStatus("error");
    }
  }, [mint, timeframe, applyTick]);

  /** Fetch unseen trades and apply them directly to candles. */
  const fetchTradeTicks = useCallback(async () => {
    try {
      const r = await fetch(`/api/token-trades?mint=${encodeURIComponent(mint)}&limit=25&_=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return;
      const rows = (await r.json()) as Array<{
        signature: string;
        timestamp: number;
        is_buy: boolean;
        sol_amount: number;
        token_amount: number;
        priceUsd?: number;
        amountUsd?: number;
        user?: string;
      }>;
      if (!Array.isArray(rows) || rows.length === 0) return;

      const fresh = rows.filter((row) => {
        if (!row?.signature || seenSigsRef.current.has(row.signature)) return false;
        seenSigsRef.current.add(row.signature);
        return true;
      });

      if (seenSigsRef.current.size > 2000) {
        seenSigsRef.current.clear();
      }

      fresh.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

      if (fresh.length === 0) return;
      setStatus("live");

      for (const row of fresh) {
        const solAmount = (Number(row.sol_amount) || 0) / 1e9;
        const tokenAmount = (Number(row.token_amount) || 0) / 1e6;
        if (!solAmount || !tokenAmount) continue;
        const priceUsd = row.priceUsd && isFinite(row.priceUsd) && row.priceUsd > 0
          ? row.priceUsd
          : (solAmount / tokenAmount) * (lastPriceRef.current || 150);
        applyTick(priceUsd, solAmount, (row.timestamp || 0) * 1000);
      }
    } catch {
      // silent fallback — websocket/poll loop will retry
    }
  }, [mint, applyTick]);

  /** Connect Helius WebSocket and listen for pump.fun program logs.
   *  Logs are only a trigger — we then pull unseen trades immediately. */
  const connectWs = useCallback(() => {
    const rpc = process.env.NEXT_PUBLIC_HELIUS_RPC_URL;
    if (!rpc) {
      setStatus("polling");
      return;
    }
    const wsUrl = rpc.replace(/^http/, "ws");
    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      setStatus("connecting");

      ws.onopen = () => {
        reconnectAttempt.current = 0;
        setStatus("live");
        // Subscribe to logs mentioning the mint — cheap heuristic to detect activity
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [{ mentions: [mint] }, { commitment: "confirmed" }],
        }));
      };

      ws.onmessage = () => {
        // Log detected — pull fresh trades (throttled to avoid duplicate bursts)
        const now = Date.now();
        const last = (ws as any).__lastPull ?? 0;
        if (now - last < 250) return;
        (ws as any).__lastPull = now;
        fetchTradeTicks();
      };

      ws.onerror = () => { /* handled by onclose */ };

      ws.onclose = () => {
        wsRef.current = null;
        if (reconnectTimer.current) return;
        const attempt = reconnectAttempt.current++;
        const delay = Math.min(30000, 1000 * Math.pow(2, attempt));
        setStatus("polling");
        reconnectTimer.current = setTimeout(() => {
          reconnectTimer.current = null;
          connectWs();
        }, delay);
      };
    } catch {
      setStatus("polling");
    }
  }, [mint, fetchTradeTicks]);

  const retry = useCallback(() => {
    setError(null);
    reconnectAttempt.current = 0;
    seenSigsRef.current.clear();
    fetchPairSnapshot(true);
    fetchTradeTicks();
    if (!wsRef.current) connectWs();
  }, [fetchPairSnapshot, fetchTradeTicks, connectWs]);

  useEffect(() => {
    if (!mint) return;
    setPair(null);
    setError(null);
    setStatus("connecting");

    // Immediately seed placeholder candles so chart renders right away
    const tfSec = TF_SECONDS[timeframe];
    const placeholder = seedCandles(0.000001, tfSec, 60);
    setCandles(placeholder);

    seenSigsRef.current.clear();

    // initial load (overwrites placeholder with real price)
    fetchPairSnapshot(true);
    fetchTradeTicks();

    // ws live ticks
    connectWs();

    // safety polling every 5s (fallback when ws is silent)
    pollRef.current = setInterval(() => {
      fetchTradeTicks();
      fetchPairSnapshot(false);
    }, 5_000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        try { wsRef.current.close(); } catch {}
        wsRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mint, timeframe]);

  const lastPrice = pair?.priceUsd ?? lastPriceRef.current ?? 0;
  const change24hPct = pair?.change24h ?? 0;
  const change24hUsd = lastPrice * (change24hPct / 100);

  return {
    candles,
    pair,
    lastPrice,
    change24h: { pct: change24hPct, usd: change24hUsd },
    status,
    error,
    retry,
  };
}
