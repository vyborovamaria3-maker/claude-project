"use client";

import { FormEvent, useState } from "react";
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Loader2, Search, Users } from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";

type FlowWindow = {
  buyers: number;
  sellers: number;
  buyer_seller_ratio: number;
  high_confidence_buyers: number;
  gross_buy_value_usd: number | null;
  gross_sell_value_usd: number | null;
  net_flow_usd: number | null;
  handles: string[];
};

type TokenKOLResponse = {
  status?: string;
  mint?: string;
  signal?: string;
  ownership_claim?: boolean;
  attribution_note?: string;
  windows?: Record<string, FlowWindow>;
  actors?: Array<{
    handle: string;
    display_name?: string | null;
    profile_confidence: number;
    verified: boolean;
    wallets: string[];
    trades: number;
    last_activity_at?: string | null;
  }>;
  error?: string;
};

function money(value: number | null | undefined) {
  if (value == null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}$${Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(0)}`;
}

function signalLabel(signal?: string) {
  if (signal === "kol_accumulation") return "KOL accumulation";
  if (signal === "kol_distribution") return "KOL distribution";
  if (signal === "mixed_kol_activity") return "Mixed KOL activity";
  return "No recent KOL activity";
}

function signalClass(signal?: string) {
  if (signal === "kol_accumulation") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-300";
  if (signal === "kol_distribution") return "border-danger/30 bg-danger/10 text-danger";
  return "border-amber-400/30 bg-amber-400/10 text-amber-300";
}

export default function KOLTokenFlowPanel() {
  const [mint, setMint] = useState("");
  const [data, setData] = useState<TokenKOLResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = mint.trim();
    if (!value) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/kols/token/${encodeURIComponent(value)}`, { cache: "no-store" });
      const payload = (await response.json()) as TokenKOLResponse;
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setData(payload);
    } catch (loadError) {
      setData(null);
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить KOL flow");
    } finally {
      setLoading(false);
    }
  }

  const windows = data?.windows ?? {};

  return (
    <section className={`${siteDesign.page.compactContainerClassName} !pb-0`} data-tag="trade.kols_token_flow">
      <div className="surface-panel rounded-2xl border border-bg-border p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-content">
              <Activity className="h-4 w-4 text-[color:var(--theme-secondary)]" />
              Token KOL Flow
            </div>
            <p className="mt-1 max-w-2xl text-[11px] leading-5 text-content-muted">
              Показывает реальные локально собранные сделки атрибутированных KOL-wallets. Related-wallet similarity не считается доказательством владения.
            </p>
          </div>
          {data?.signal ? (
            <span className={`inline-flex w-fit rounded-full border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide ${signalClass(data.signal)}`}>
              {signalLabel(data.signal)}
            </span>
          ) : null}
        </div>

        <form onSubmit={submit} className="mt-4 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-faint" />
            <input
              value={mint}
              onChange={(event) => setMint(event.target.value)}
              placeholder="Solana token mint"
              className={`${siteDesign.controls.inputClassName} pl-9 font-mono`}
            />
          </div>
          <button type="submit" disabled={loading || !mint.trim()} className={siteDesign.controls.primaryActionClassName}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
            Проверить flow
          </button>
        </form>

        {error ? (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
            <AlertTriangle className="h-4 w-4" /> {error}
          </div>
        ) : null}

        {data?.status === "no_local_token_history" ? (
          <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-content-muted">
            Для этого mint пока нет локальной истории `wallet_trades`. Сигнал не выдумывается — появится после того, как collector увидит сделки отслеживаемых wallets.
          </div>
        ) : null}

        {data?.status === "ok" ? (
          <div className="mt-4 space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              {(["1h", "24h", "7d"] as const).map((windowKey) => {
                const row = windows[windowKey];
                if (!row) return null;
                return (
                  <div key={windowKey} className="rounded-xl border border-bg-border bg-bg-elevated/40 p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-content-faint">{windowKey}</div>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div>
                        <div className="flex items-center gap-1 text-[10px] text-content-muted"><ArrowUpRight className="h-3 w-3 text-emerald-300" /> Buyers</div>
                        <div className="mt-0.5 text-lg font-semibold text-content">{row.buyers}</div>
                      </div>
                      <div>
                        <div className="flex items-center gap-1 text-[10px] text-content-muted"><ArrowDownRight className="h-3 w-3 text-danger" /> Sellers</div>
                        <div className="mt-0.5 text-lg font-semibold text-content">{row.sellers}</div>
                      </div>
                    </div>
                    <div className="mt-3 space-y-1 text-[10px] text-content-muted">
                      <div className="flex justify-between gap-3"><span>Net flow</span><span className="font-mono text-content">{money(row.net_flow_usd)}</span></div>
                      <div className="flex justify-between gap-3"><span>High-conf buyers</span><span className="font-mono text-content">{row.high_confidence_buyers}</span></div>
                      <div className="flex justify-between gap-3"><span>Buy/Sell KOL ratio</span><span className="font-mono text-content">{row.buyer_seller_ratio.toFixed(2)}</span></div>
                    </div>
                  </div>
                );
              })}
            </div>

            {data.actors?.length ? (
              <div className="rounded-xl border border-bg-border overflow-hidden">
                <div className="flex items-center gap-2 border-b border-bg-border bg-bg-elevated/50 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-content-faint">
                  <Users className="h-3.5 w-3.5" /> Active KOLs
                </div>
                <div className="divide-y divide-bg-border">
                  {data.actors.slice(0, 12).map((actor) => (
                    <div key={actor.handle} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                      <div>
                        <div className="font-semibold text-content">{actor.display_name || `@${actor.handle}`}</div>
                        <div className="text-[10px] text-content-muted">@{actor.handle} · {actor.wallets.length} wallet(s)</div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-content">{actor.trades} trades</div>
                        <div className="text-[10px] text-content-muted">confidence {Math.round(actor.profile_confidence)}/100</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
