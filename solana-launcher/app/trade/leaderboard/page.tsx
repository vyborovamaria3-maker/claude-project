"use client";
// data-tag: app.trade.leaderboard
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Trophy, Wallet as WalletIcon, Hammer, RefreshCw, Activity, Play, Square, Copy } from "lucide-react";
import { authHeaders } from "@/lib/clientAuth";

type Tab = "wallets-pnl" | "wallets-vol" | "devs-tokens" | "devs-migration" | "devs-300k";

interface WalletItem {
  address: string;
  totalVolumeSol: number;
  totalPnlSol: number;
  tokensTraded: number;
  totalBuys: number;
  totalSells: number;
  freshTokens?: number;
  washTokens?: number;
}

interface DevItem {
  address: string;
  totalTokens: number;
  migratedCount: number;
  migrationRate: number;
  reached300kCount: number;
  rate300k: number;
  bestLaunchHour: number | null;
  userTag?: string | null;
}

interface IndexerStats {
  connected: boolean;
  startedAt: number | null;
  totalEvents: number;
  newTokensCount: number;
  errors: number;
  lastEventAt: number | null;
  lastMint: string | null;
  lastCreator: string | null;
}

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "wallets-pnl", label: "Топ кошельков (PnL)", icon: <Trophy className="w-3.5 h-3.5" /> },
  { id: "wallets-vol", label: "Топ кошельков (объём)", icon: <WalletIcon className="w-3.5 h-3.5" /> },
  { id: "devs-tokens", label: "Топ DEV (по токенам)", icon: <Hammer className="w-3.5 h-3.5" /> },
  { id: "devs-migration", label: "Топ DEV (migration%)", icon: <Hammer className="w-3.5 h-3.5" /> },
  { id: "devs-300k", label: "Топ DEV (300K hits)", icon: <Hammer className="w-3.5 h-3.5" /> },
];

function fmtNum(n: number, decimals = 2): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(decimals);
}

export default function LeaderboardPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("wallets-pnl");
  const [items, setItems] = useState<(WalletItem | DevItem)[]>([]);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<IndexerStats | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [kind, orderBy] = tab.split("-");
      const r = await fetch(
        `/api/trade/leaderboard?kind=${kind === "devs" ? "devs" : "wallets"}&orderBy=${orderBy}&limit=100`,
        { cache: "no-store" }
      );
      const d = await r.json();
      setItems(d.items || []);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  const fetchStats = useCallback(async () => {
    const r = await fetch("/api/trade/pump-indexer", { cache: "no-store" });
    setStats(await r.json());
  }, []);

  const startIndexer = async () => {
    await fetch("/api/trade/pump-indexer", { method: "POST", headers: authHeaders() });
    await fetchStats();
  };
  const stopIndexer = async () => {
    await fetch("/api/trade/pump-indexer", { method: "DELETE", headers: authHeaders() });
    await fetchStats();
  };

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    fetchStats();
    const id = setInterval(fetchStats, 5_000);
    return () => clearInterval(id);
  }, [fetchStats]);

  const isDevs = tab.startsWith("devs");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="w-9 h-9 rounded-lg bg-neon-purple/15 border border-neon-purple/30 flex items-center justify-center">
          <Trophy className="w-5 h-5 text-neon-purple" />
        </div>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-white">Trade · Leaderboard</h1>
          <p className="text-xs text-white/40">Топ кошельков и DEV-ов по накопленным данным</p>
        </div>
        <button
          onClick={fetchData}
          className="p-2 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white border border-bg-border"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* PumpPortal indexer panel */}
      <div className="rounded-xl border border-bg-border bg-bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Activity className={`w-4 h-4 ${stats?.connected ? "text-green-400 animate-pulse" : "text-white/40"}`} />
            <h3 className="text-sm font-semibold text-white">PumpPortal Indexer</h3>
            <span className={`text-[10px] px-2 py-0.5 rounded ${stats?.connected ? "bg-green-500/15 text-green-400" : "bg-white/5 text-white/40"}`}>
              {stats?.connected ? "ONLINE" : "OFFLINE"}
            </span>
          </div>
          <div className="flex gap-2">
            {!stats?.connected ? (
              <button onClick={startIndexer} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-green-500/15 text-green-400 text-xs border border-green-500/30 hover:bg-green-500/20">
                <Play className="w-3 h-3" /> Старт
              </button>
            ) : (
              <button onClick={stopIndexer} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-500/15 text-red-400 text-xs border border-red-500/30 hover:bg-red-500/20">
                <Square className="w-3 h-3" /> Стоп
              </button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <Stat label="Новые токены" value={stats?.newTokensCount?.toLocaleString() ?? "0"} />
          <Stat label="Всего событий" value={stats?.totalEvents?.toLocaleString() ?? "0"} />
          <Stat label="Ошибки" value={stats?.errors?.toString() ?? "0"} />
          <Stat label="Аптайм" value={stats?.startedAt ? `${Math.floor((Date.now() - stats.startedAt) / 60000)}m` : "—"} />
        </div>
        {stats?.lastMint && (
          <div className="mt-3 pt-3 border-t border-bg-border text-[10px] text-white/40">
            Последний токен: <span className="text-white/70 font-mono">{stats.lastMint.slice(0, 12)}…</span>
            {" от "}
            <span className="text-white/70 font-mono">{stats.lastCreator?.slice(0, 8)}…</span>
          </div>
        )}
        <p className="mt-2 text-[10px] text-white/40">
          Подключается к wss://pumpportal.fun и сохраняет связку (mint → creator) в БД для точного DEV-анализа.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium border transition ${
              tab === t.id
                ? "bg-neon-purple/15 text-neon-purple border-neon-purple/30"
                : "bg-white/5 text-white/60 border-bg-border hover:text-white"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-bg-border bg-bg-card overflow-hidden">
        <div className="max-h-[600px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-bg-card border-b border-bg-border">
              <tr className="text-white/50">
                <th className="px-3 py-2 text-left font-medium w-12">#</th>
                <th className="px-3 py-2 text-left font-medium">Адрес</th>
                {isDevs ? (
                  <>
                    <th className="px-3 py-2 text-right font-medium">Токенов</th>
                    <th className="px-3 py-2 text-right font-medium">Migrated</th>
                    <th className="px-3 py-2 text-right font-medium">300K</th>
                    <th className="px-3 py-2 text-right font-medium">Hour</th>
                  </>
                ) : (
                  <>
                    <th className="px-3 py-2 text-right font-medium">PnL (SOL)</th>
                    <th className="px-3 py-2 text-right font-medium">Объём (SOL)</th>
                    <th className="px-3 py-2 text-right font-medium">Токенов</th>
                    <th className="px-3 py-2 text-right font-medium">B/S</th>
                  </>
                )}
                <th className="px-3 py-2 text-center font-medium w-10"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => {
                const addr = item.address;
                if (isDevs) {
                  const d = item as DevItem;
                  return (
                    <tr key={addr} className="border-t border-bg-border hover:bg-white/3">
                      <td className="px-3 py-2 text-white/40">{idx + 1}</td>
                      <td className="px-3 py-2 font-mono text-white/80">
                        {addr.slice(0, 8)}…{addr.slice(-4)}
                        {d.userTag && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-neon-purple/15 text-neon-purple">{d.userTag}</span>}
                      </td>
                      <td className="px-3 py-2 text-right text-white">{d.totalTokens}</td>
                      <td className="px-3 py-2 text-right text-white/70">
                        {d.migratedCount} <span className="text-white/40">({(d.migrationRate * 100).toFixed(1)}%)</span>
                      </td>
                      <td className="px-3 py-2 text-right text-white/70">
                        {d.reached300kCount} <span className="text-white/40">({(d.rate300k * 100).toFixed(1)}%)</span>
                      </td>
                      <td className="px-3 py-2 text-right text-white/50">{d.bestLaunchHour ?? "—"}</td>
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={() => navigator.clipboard.writeText(addr)}
                          className="p-1 text-white/30 hover:text-white"
                          title="Копировать"
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                      </td>
                    </tr>
                  );
                }
                const w = item as WalletItem;
                const pnlColor = w.totalPnlSol >= 0 ? "text-green-400" : "text-red-400";
                return (
                  <tr key={addr} className="border-t border-bg-border hover:bg-white/3">
                    <td className="px-3 py-2 text-white/40">{idx + 1}</td>
                    <td className="px-3 py-2 font-mono text-white/80">
                      {addr.slice(0, 8)}…{addr.slice(-4)}
                    </td>
                    <td className={`px-3 py-2 text-right font-semibold ${pnlColor}`}>
                      {w.totalPnlSol >= 0 ? "+" : ""}{fmtNum(w.totalPnlSol, 3)}
                    </td>
                    <td className="px-3 py-2 text-right text-white/70">{fmtNum(w.totalVolumeSol, 2)}</td>
                    <td className="px-3 py-2 text-right text-white/70">{w.tokensTraded}</td>
                    <td className="px-3 py-2 text-right text-white/50">
                      {w.totalBuys}/{w.totalSells}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button
                        onClick={() => navigator.clipboard.writeText(addr)}
                        className="p-1 text-white/30 hover:text-white"
                        title="Копировать"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {items.length === 0 && !loading && (
                <tr>
                  <td colSpan={7} className="px-3 py-12 text-center text-white/40">
                    Нет данных. Запусти анализ нескольких токенов на странице{" "}
                    <button
                      onClick={() => router.push("/trade/analysis")}
                      className="text-neon-purple hover:underline"
                    >
                      Analysis
                    </button>
                    , и здесь появятся накопленные статы.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-white/5 border border-bg-border px-3 py-2">
      <div className="text-[10px] text-white/40 uppercase tracking-wide">{label}</div>
      <div className="text-sm text-white font-semibold mt-0.5">{value}</div>
    </div>
  );
}
