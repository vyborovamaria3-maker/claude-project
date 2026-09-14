"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Loader2, RefreshCw, Radio } from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";

type TradeEvent = {
  handle: string;
  name?: string | null;
  profileConfidence: number;
  walletConfidence: number;
  verified: boolean;
  wallet: string;
  mint: string;
  symbol?: string | null;
  tokenName?: string | null;
  side: "buy" | "sell";
  timestamp: string;
  amount?: number | null;
  priceUsd?: number | null;
  valueUsd?: number | null;
  realizedProfitUsd?: number | null;
};

type FeedResponse = { items?: TradeEvent[]; error?: string };

function money(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}m`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

function since(value: string) {
  const ms = Date.now() - Date.parse(value);
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export default function KOLLiveTradeFeed() {
  const [items, setItems] = useState<TradeEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/kols/live-trades?limit=40", { cache: "no-store" });
      const payload = (await response.json()) as FeedResponse;
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setItems(payload.items ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Live feed unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <section className={`${siteDesign.page.compactContainerClassName} !py-0`} data-tag="trade.kols_live_feed">
      <div className="surface-panel rounded-2xl border border-bg-border overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-bg-border px-4 py-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-content"><Radio className="h-4 w-4 text-emerald-300" /> Live KOL Trades</div>
            <div className="mt-0.5 text-[10px] text-content-muted">Обновление раз в минуту из локальных wallet_trades.</div>
          </div>
          <button type="button" onClick={() => void load()} className={siteDesign.controls.iconButtonClassName} aria-label="Refresh KOL trades">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>

        {error ? <div className="px-4 py-3 text-xs text-danger">{error}</div> : null}
        {!error && !loading && items.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-content-muted">Пока нет сделок атрибутированных KOL-wallets в локальной базе.</div>
        ) : null}
        {items.length ? (
          <div className="max-h-[360px] divide-y divide-bg-border overflow-y-auto">
            {items.map((event, index) => (
              <div key={`${event.handle}:${event.mint}:${event.side}:${event.timestamp}:${index}`} className="grid gap-2 px-4 py-3 md:grid-cols-[1.1fr_.8fr_.6fr_.35fr] md:items-center">
                <div className="min-w-0">
                  <Link href={`/trade/kols-twitter/${encodeURIComponent(event.handle)}`} className="font-semibold text-content hover:text-primary">@{event.handle}</Link>
                  <div className="mt-0.5 truncate font-mono text-[9px] text-content-faint">{event.wallet}</div>
                </div>
                <div className="min-w-0">
                  <div className="truncate font-semibold text-content">{event.symbol || event.tokenName || "Unknown token"}</div>
                  <div className="mt-0.5 truncate font-mono text-[9px] text-content-faint">{event.mint}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[9px] font-semibold uppercase ${event.side === "buy" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : "border-danger/30 bg-danger/10 text-danger"}`}>
                    {event.side === "buy" ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}{event.side}
                  </span>
                  <span className="font-mono text-xs text-content">{money(event.valueUsd)}</span>
                </div>
                <div className="text-right text-[10px] text-content-muted">{since(event.timestamp)}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
