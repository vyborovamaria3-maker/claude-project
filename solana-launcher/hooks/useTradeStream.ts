"use client";
// data-tag: hooks.use_trade_stream
// Polls Pump.fun public trades API for real-time trade activity.
// PumpPortal WS requires a paid API key (≥0.02 SOL) — not used here.
// Pump.fun swap API is public and returns real block timestamps.

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
  inFlight: boolean;
}

const polls = new Map<string, SharedPoll>();

function setOnline(p: SharedPoll, online: boolean) {
  if (p.isOnline === online) return;
  p.isOnline = online;
  p.statusListeners.forEach((listener) => listener(online));
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
    const response = await fetch(
      `/api/token-trades?mint=${encodeURIComponent(p.mint)}&limit=25&_=${Date.now()}`,
      { cache: "no-store" },
    );
    if (!response.ok) {
      setOnline(p, false);
      return;
    }
    const rows = (await response.json()) as PumpTrade[];
    if (!Array.isArray(rows)) {
      setOnline(p, false);
      return;
    }
    setOnline(p, true);

    // Process newest-first, emit only unseen.
    // Walk in reverse so callbacks see oldest-first within the new batch.
    const fresh: TradeItem[] = [];
    for (const row of rows) {
      if (!row.signature || p.seenSigs.has(row.signature)) continue;
      if (row.timestamp == null || !Number.isFinite(row.timestamp) || row.timestamp <= 0) continue;

      const solAmount = Number(row.sol_amount) / 1e9;
      const tokenAmount = Number(row.token_amount) / 1e6;
      if (!Number.isFinite(solAmount) || solAmount <= 0 || !Number.isFinite(tokenAmount) || tokenAmount <= 0) continue;

      const upstreamPriceUsd = Number(row.priceUsd);
      const upstreamAmountUsd = Number(row.amountUsd);
      const priceUsd = Number.isFinite(upstreamPriceUsd) && upstreamPriceUsd > 0
        ? upstreamPriceUsd
        : Number.isFinite(upstreamAmountUsd) && upstreamAmountUsd > 0
          ? upstreamAmountUsd / tokenAmount
          : 0;
      const ts = row.timestamp * 1000;

      // Mark a signature as seen only after the row is usable. If an upstream
      // partial row is repaired on a later poll, we must still be able to emit it.
      p.seenSigs.add(row.signature);
      if (p.seenSigs.size > 2000) {
        const iterator = p.seenSigs.values();
        const oldest = iterator.next().value as string | undefined;
        if (oldest) p.seenSigs.delete(oldest);
      }

      fresh.push({
        signature: row.signature,
        ts,
        isBuy: Boolean(row.is_buy),
        solAmount,
        tokenAmount,
        priceUsd,
        marketCap: Number.isFinite(Number(row.usd_market_cap)) ? Number(row.usd_market_cap) : null,
        signer: row.user ?? "",
      });
    }
    // Emit oldest-first so trade list animates in chronological order.
    for (let index = fresh.length - 1; index >= 0; index -= 1) {
      const trade = fresh[index];
      p.subscribers.forEach((subscriber) => {
        try { subscriber(trade); } catch { /* isolate subscribers */ }
      });
    }
  } catch {
    setOnline(p, false);
  } finally {
    p.inFlight = false;
  }
}

function startPoll(p: SharedPoll) {
  if (p.timer) return;
  void fetchTrades(p); // immediate first fetch
  p.timer = setInterval(() => { void fetchTrades(p); }, POLL_INTERVAL);
}

function stopPoll(p: SharedPoll) {
  if (p.timer) {
    clearInterval(p.timer);
    p.timer = null;
  }
  setOnline(p, false);
}

function subscribe(mint: string, onTrade: Subscriber, onStatus: StatusListener): () => void {
  let p = polls.get(mint);
  if (!p) {
    p = {
      mint,
      subscribers: new Set(),
      statusListeners: new Set(),
      isOnline: false,
      timer: null,
      seenSigs: new Set(),
      inFlight: false,
    };
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
  onTradeCallback?: (trade: TradeItem) => void,
  options?: { headless?: boolean },
) {
  const [trades, setTrades] = useState<TradeItem[]>([]);
  const [isOnline, setIsOnline] = useState(false);
  const headless = options?.headless ?? false;
  const onTradeCallbackRef = useRef(onTradeCallback);
  onTradeCallbackRef.current = onTradeCallback;
  const maxRef = useRef(max);
  maxRef.current = max;

  useEffect(() => {
    setTrades([]);
    setIsOnline(false);
  }, [mint]);

  useEffect(() => {
    if (!mint) return undefined;
    const onTrade = (trade: TradeItem) => {
      if (onTradeCallbackRef.current) onTradeCallbackRef.current(trade);
      if (headless) return;
      setTrades((previous) => {
        if (previous.some((item) => item.signature === trade.signature)) return previous;
        const next = [trade, ...previous];
        return next.length > maxRef.current ? next.slice(0, maxRef.current) : next;
      });
    };
    const onStatus = (online: boolean) => setIsOnline(online);
    return subscribe(mint, onTrade, onStatus);
  }, [mint, headless]); // only re-subscribe when mint/headless changes

  return { trades, isOnline };
}
