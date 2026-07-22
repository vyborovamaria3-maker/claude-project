"use client";
// data-tag: components.trade.PumpFeed
// Live feed of NEW / BONDING / GRADUATED pump.fun tokens (via Moralis).
import { useEffect, useState, useCallback } from "react";
import { Flame, Sparkles, TrendingUp, RefreshCw, Copy, ExternalLink } from "lucide-react";

type FeedType = "new" | "bonding" | "graduated";

interface PumpToken {
  mint: string;
  name: string;
  symbol: string;
  logo: string | null;
  priceUsd: number | null;
  liquidity: number | null;
  fdv: number | null;
  createdAt: string | null;
  type: FeedType;
}

const TABS: { id: FeedType; label: string; icon: React.ReactNode; tint: string }[] = [
  { id: "new", label: "Новые", icon: <Sparkles className="w-3.5 h-3.5" />, tint: "text-cyan-400" },
  { id: "bonding", label: "На bonding", icon: <Flame className="w-3.5 h-3.5" />, tint: "text-orange-400" },
  { id: "graduated", label: "Migrated", icon: <TrendingUp className="w-3.5 h-3.5" />, tint: "text-green-400" },
];

function formatNum(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

export default function PumpFeed({ onPickMint }: { onPickMint?: (mint: string) => void }) {
  const [tab, setTab] = useState<FeedType>("new");
  const [tokens, setTokens] = useState<PumpToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchFeed = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/trade/pumpfun-feed?type=${tab}&limit=50`, { cache: "no-store" });
      const d = await r.json();
      setTokens(d.tokens || []);
    } catch {
      setTokens([]);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    fetchFeed();
  }, [fetchFeed]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchFeed, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchFeed]);

  return (
    <div className="rounded-xl border border-bg-border bg-bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-bg-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Flame className="w-4 h-4 text-neon-purple" />
          <h3 className="text-sm font-semibold text-white">Pump.fun лента</h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className={`text-[10px] px-2 py-1 rounded border transition ${
              autoRefresh
                ? "bg-neon-purple/15 text-neon-purple border-neon-purple/30"
                : "bg-white/5 text-white/50 border-bg-border"
            }`}
            title="Авто-обновление каждые 30с"
          >
            Auto {autoRefresh ? "on" : "off"}
          </button>
          <button
            onClick={fetchFeed}
            className="p-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white border border-bg-border"
            title="Обновить"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div className="px-4 pt-3 flex gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition border ${
              tab === t.id
                ? `bg-white/10 ${t.tint} border-white/20`
                : "bg-white/5 text-white/50 border-bg-border hover:text-white/80"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      <div className="max-h-[400px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-bg-card border-b border-bg-border">
            <tr className="text-white/50">
              <th className="px-3 py-2 text-left font-medium">Токен</th>
              <th className="px-3 py-2 text-right font-medium">Liq</th>
              <th className="px-3 py-2 text-right font-medium">FDV</th>
              <th className="px-3 py-2 text-right font-medium">Возраст</th>
              <th className="px-3 py-2 text-center font-medium w-16"></th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr
                key={t.mint}
                className="border-t border-bg-border hover:bg-white/3 cursor-pointer"
                onClick={() => onPickMint?.(t.mint)}
              >
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    {t.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={t.logo} alt="" className="w-6 h-6 rounded-full bg-white/5" />
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-white/5 flex items-center justify-center text-[10px] text-white/40">
                        {(t.symbol || "?").slice(0, 1)}
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="text-white font-semibold truncate max-w-[140px]">
                        {t.symbol || "—"}
                      </div>
                      <div className="text-white/40 text-[10px] truncate max-w-[140px]">
                        {t.name || t.mint.slice(0, 8)}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2 text-right text-white/70">
                  {t.liquidity != null ? `$${formatNum(t.liquidity)}` : "—"}
                </td>
                <td className="px-3 py-2 text-right text-white/70">
                  {t.fdv != null ? `$${formatNum(t.fdv)}` : "—"}
                </td>
                <td className="px-3 py-2 text-right text-white/50">{timeAgo(t.createdAt)}</td>
                <td className="px-3 py-2 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(t.mint);
                      }}
                      className="p-1 text-white/30 hover:text-white"
                      title={t.mint}
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                    <a
                      href={`https://pump.fun/coin/${t.mint}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="p-1 text-white/30 hover:text-neon-purple"
                      title="Открыть на pump.fun"
                    >
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </td>
              </tr>
            ))}
            {tokens.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-white/40 text-xs">
                  Нет данных
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
