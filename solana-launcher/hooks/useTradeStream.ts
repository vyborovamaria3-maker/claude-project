"use client";
// data-tag: hooks.use_trade_stream
// Polls Pump.fun public trades API for real-time trade activity.
// PumpPortal WS requires a paid API key (≥0.02 SOL) — not used here.
// Pump.fun frontend-api is public and returns real block timestamps.

import { useEffect, useRef, useState } from "react";

const POLL_INTERVAL = 250; // 250ms — максимально быстро без перекрывающихся запросов

export interface TradeItem {
  signature: string;
  ts: number;          // ms — real block time
  isBuy: boolean;
  solAmount: number;
  tokenAmount: number;
  priceUsd: number;
  marketCap: number | null;
  signer: string;
  newHolder?: boolean;
}

// ── Shared polling manager (module-level singleton) ───────────────────────
// Multiple components using the same mint share one poll loop.
type Subscriber = (trade: TradeItem) => void;
type StatusListener = (online: boolean) => void;

interface SharedPoll {
  mint: string;
  subscribers: Set<Subscriber>;
  statusListeners: Set<StatusListener>;
  isOnline: boolean;
  timer: ReturnType<typeof setInterval> | null;
  seenSigs: Set<string>;
  lastSolPrice: number;
  inFlight: boolean;
}

const polls = new Map<string, SharedPoll>();

function setOnline(p: SharedPoll, online: boolean) {
  if (p.isOnline === online) return;
  p.isOnline = online;
  p.statusListeners.forEach(l => l(online));
}

type PumpTrade = {
  signature: string;
  sol_amount: number;
  token_amount: number;
  is_buy: boolean;
  timestamp: number | null; // unix seconds; null when upstream timestamp is invalid
  user: string;
  priceUsd?: number;
  amountUsd?: number;
  program?: string;
  usd_market_cap?: number;
  slot?: number;
};

async function fetchTrades(p: SharedPoll): Promise<void> {
  if (p.inFlight) return;
  p.inFlight = true;
  try {
    const r = await fetch(
      `/api/token-trades?mint=${p.mint}&limit=25&_=${Date.now()}`,
      { cache: "no-store" }
    );
    if (!r.ok) { setOnline(p, false); return; }
    const rows = (await r.json()) as PumpTrade[];
    if (!Array.isArray(rows)) { setOnline(p, false); return; }
    setOnline(p, true);

    // Process newest-first, emit only unseen.
    // Walk in reverse so callbacks see oldest-first within the new batch.
    const fresh: TradeItem[] = [];
    for (const row of rows) {
      if (p.seenSigs.has(row.signature)) continue;
      p.seenSigs.add(row.signature);
      if (p.seenSigs.size > 2000) {
        const iter = p.seenSigs.values();
        p.seenSigs.delete(iter.next().value!);
      }

      if (row.timestamp == null || !Number.isFinite(row.timestamp) || row.timestamp <= 0) continue;
      const solAmount = row.sol_amount / 1e9;
      const tokenAmount = row.token_amount / 1e6;
      if (!solAmount || !tokenAmount) continue;

      // Prefer real on-chain priceUsd from server; fall back to derived.
      const priceUsd = row.priceUsd && isFinite(row.priceUsd) && row.priceUsd > 0
        ? row.priceUsd
        : (solAmount / tokenAmount) * (p.lastSolPrice || 150);
      const ts = row.timestamp * 1000;

      fresh.push({
        signature: row.signature,
        ts,
        isBuy: row.is_buy,
        solAmount,
        tokenAmount,
        priceUsd,
        marketCap: row.usd_market_cap ?? null,
        signer: row.user ?? "",
      });
    }
    // Emit oldest-first so trade list animates in chronological order
    for (let i = fresh.length - 1; i >= 0; i--) {
      const t = fresh[i];
      p.subscribers.forEach(s => { try { s(t); } catch { /* ignore */ } });
    }
  } catch {
    setOnline(p, false);
  } finally {
    p.inFlight = false;
  }
}

function startPoll(p: SharedPoll) {
  if (p.timer) return;
  fetchTrades(p); // immediate first fetch
  p.timer = setInterval(() => fetchTrades(p), POLL_INTERVAL);
}

function stopPoll(p: SharedPoll) {
  if (p.timer) { clearInterval(p.timer); p.timer = null; }
  setOnline(p, false);
}

function subscribe(mint: string, onTrade: Subscriber, onStatus: StatusListener): () => void {
  let p = polls.get(mint);
  if (!p) {
    p = { mint, subscribers: new Set(), statusListeners: new Set(), isOnline: false, timer: null, seenSigs: new Set(), lastSolPrice: 0, inFlight: false };
    polls.set(mint, p);
  }
  p.subscribers.add(onTrade);
  p.statusListeners.add(onStatus);
  onStatus(p.isOnline);
  startPoll(p);

  return () => {
    p!.subscribers.delete(onTrade);
    p!.statusListeners.delete(onStatus);
    setTimeout(() => {
      if (p!.subscribers.size === 0) {
        stopPoll(p!);
        polls.delete(mint);
      }
    }, 500);
  };
}

// ── Hook ─────────────────────────────────────────────────────────────────
export function useTradeStream(
  mint: string,
  max = 100,
  onTradeCallback?: (t: TradeItem) => void,
  options?: { headless?: boolean }
) {
  const [trades, setTrades] = useState<TradeItem[]>([]);
  const [isOnline, setIsOnline] = useState(false);
  const headless = options?.headless ?? false;
  const onTradeCallbackRef = useRef(onTradeCallback);
  onTradeCallbackRef.current = onTradeCallback;
  const maxRef = useRef(max);
  maxRef.current = max;

  // Reset trades when mint changes (separate effect to avoid re-subscribe loop)
  const prevMintRef = useRef(mint);
  if (prevMintRef.current !== mint) {
    prevMintRef.current = mint;
    // Will be picked up on next render; avoid setState during render by using ref flag
  }

  useEffect(() => {
    setTrades([]);
  }, [mint]);

  useEffect(() => {
    if (!mint) return;
    const onTrade = (t: TradeItem) => {
      if (onTradeCallbackRef.current) onTradeCallbackRef.current(t);
      if (headless) return;
      setTrades(prev => {
        if (prev.some(x => x.signature === t.signature)) return prev;
        const next = [t, ...prev];
        return next.length > maxRef.current ? next.slice(0, maxRef.current) : next;
      });
    };
    const onStatus = (online: boolean) => setIsOnline(online);
    return subscribe(mint, onTrade, onStatus);
  }, [mint, headless]); // only re-subscribe when mint/headless changes

  return { trades, isOnline };
}
