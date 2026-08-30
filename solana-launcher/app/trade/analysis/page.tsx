"use client";
// data-tag: app.trade.analysis

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, AlertTriangle, TrendingUp, Download, ArrowUp, ArrowDown, RefreshCw } from "lucide-react";
import SearchBar from "@/components/trade/SearchBar";
import TokenInfo from "@/components/trade/TokenInfo";
import { DEFAULT_FILTERS, type TradeFilters } from "@/components/trade/FiltersPanel";
import type { WalletRowData } from "@/components/trade/WalletRow";
import type { CompactTrade } from "@/components/trade/WalletTradeDetail";
import { loadPageState, savePageState } from "@/lib/pageState";

const FiltersPanel = dynamic(() => import("@/components/trade/FiltersPanel"), {
  loading: () => <div className="glass rounded-xl border border-bg-border p-4 text-xs text-white/40">Загружаю фильтры…</div>,
});
const WalletRow = dynamic(() => import("@/components/trade/WalletRow"), {
  loading: () => <div className="glass rounded-lg border border-bg-border p-4 text-xs text-white/40">Загружаю кошелёк…</div>,
});
const DevAnalysis = dynamic(() => import("@/components/trade/DevAnalysis"), {
  loading: () => <div className="glass rounded-xl border border-bg-border p-6 text-sm text-white/40">Загружаю DEV анализ…</div>,
});
const PumpFunChart = dynamic(() => import("@/components/PumpFunChart"), {
  ssr: false,
  loading: () => <div className="glass rounded-xl border border-bg-border h-[520px] flex items-center justify-center text-sm text-white/40">Загружаю график…</div>,
});

interface AnalysisData {
  mint: string;
  summary: {
    totalVolumeSol: number;
    totalVolumeUsd: number;
    totalTrades: number;
    uniqueWallets: number;
    biggestBuy?: { wallet: string; amountSol: number };
    biggestSell?: { wallet: string; amountSol: number };
    periodStart?: number | null;
    periodEnd?: number | null;
    totalRawTrades?: number;
  };
  wallets: WalletRowData[];
  dev: { address: string; userTag?: string | null } | null;
  bundles: { id: string; size: number; totalVolumeSol: number; wallets: string[] }[];
  timeline: { ts: number; buyVolSol: number; sellVolSol: number; price: number }[];
  trades: CompactTrade[];
  fetchedAt: number;
}

const ANALYSIS_PAGE_STATE_KEY = "trade.analysis.page.v1";
const ANALYSIS_RESULTS_STATE_PREFIX = "trade.analysis.results.v1:";

interface TradeAnalysisPageState {
  mint: string;
  data: AnalysisData | null;
  error: string | null;
}

interface AnalysisResultsViewState {
  filters: TradeFilters;
  sortKey: SortKey;
  sortDir: SortDir;
  openPanel: DetailPanel;
}

export default function TradeAnalysisPage() {
  const router = useRouter();
  const params = useSearchParams();
  const initialMint = params.get("mint") || "";

  const [mint, setMint] = useState(initialMint);
  const [data, setData] = useState<AnalysisData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ phase: string; fetched: number; page: number } | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(0);
  const [hasRestoredState, setHasRestoredState] = useState(false);

  useEffect(() => {
    const restored = loadPageState<TradeAnalysisPageState | null>(ANALYSIS_PAGE_STATE_KEY, null);
    if (restored && (!initialMint || !restored.mint || restored.mint === initialMint)) {
      if (restored.mint) setMint(restored.mint);
      if (restored.data) setData(restored.data);
      if (restored.error) setError(restored.error);
    }
    setHasRestoredState(true);
  }, [initialMint]);

  useEffect(() => {
    if (!hasRestoredState) return;
    savePageState<TradeAnalysisPageState>(ANALYSIS_PAGE_STATE_KEY, {
      mint,
      data,
      error,
    });
  }, [hasRestoredState, mint, data, error]);

  // 1s tick while loading so ETA updates live
  useEffect(() => {
    if (!isLoading) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [isLoading]);

  const runAnalysis = useCallback(async (m: string, refresh = false) => {
    setMint(m);
    setIsLoading(true);
    setError(null);
    setProgress(null);
    setData(null);
    setStartedAt(Date.now());
    try {
      const r = await fetch(
        `/api/trade/analyze-stream?mint=${encodeURIComponent(m)}${refresh ? "&refresh=1" : ""}`,
        { cache: "no-store" }
      );
      if (!r.ok || !r.body) {
        const txt = await r.text().catch(() => "");
        throw new Error(txt || `HTTP ${r.status}`);
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: { type: string; [k: string]: unknown };
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type === "progress") {
            setProgress({ phase: String(evt.phase), fetched: Number(evt.fetched), page: Number(evt.page) });
          } else if (evt.type === "final") {
            const { type: _t, ...rest } = evt;
            void _t;
            setData(rest as unknown as AnalysisData);
          } else if (evt.type === "error") {
            throw new Error(String(evt.message));
          }
        }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка анализа");
      setData(null);
    } finally {
      setIsLoading(false);
      setProgress(null);
      setStartedAt(null);
    }
    router.replace(`/trade/analysis?mint=${encodeURIComponent(m)}`);
  }, [router]);

  useEffect(() => {
    if (!initialMint) return;
    const restored = loadPageState<TradeAnalysisPageState | null>(ANALYSIS_PAGE_STATE_KEY, null);
    const canReuseRestored = !!restored?.data && restored.mint === initialMint;
    if (!canReuseRestored) runAnalysis(initialMint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-5" data-tag="trade.analysis_page">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="w-9 h-9 rounded-lg bg-neon-purple/15 border border-neon-purple/30 flex items-center justify-center">
          <TrendingUp className="w-5 h-5 text-neon-purple" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-white">Trade · Analysis</h1>
          <p className="text-xs text-white/40">
            Глубокий анализ трейдов, кошельков и DEV-активности по Pump.fun токенам
          </p>
        </div>
      </div>

      {/* Search */}
      <div className="flex gap-2 items-stretch">
        <div className="flex-1">
          <SearchBar onSearch={runAnalysis} isLoading={isLoading} initialValue={mint} />
        </div>
        {mint && (
          <button
            type="button"
            onClick={() => runAnalysis(mint, true)}
            disabled={isLoading}
            title="Сбросить кеш и переанализировать"
            className="px-3 py-3 rounded-lg bg-white/5 border border-bg-border text-white/70 hover:text-white disabled:opacity-40 flex items-center"
            data-tag="trade.refresh"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-neon-red/10 border border-neon-red/30 text-sm">
          <AlertTriangle className="w-4 h-4 text-neon-red mt-0.5" />
          <div>
            <div className="text-neon-red font-semibold">Ошибка анализа</div>
            <div className="text-white/60 text-xs mt-0.5">{error}</div>
          </div>
        </div>
      )}

      {/* Empty state — show live pump.fun feed */}
      {!data && !isLoading && !error && (
        <div className="space-y-4">
          <div className="flex items-center justify-center py-12 glass rounded-xl border border-bg-border">
            <p className="text-sm text-white/40">
              Введи mint адрес токена выше, чтобы начать анализ
            </p>
          </div>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="flex flex-col items-center justify-center py-24 glass rounded-xl border border-bg-border gap-3">
          <Loader2 className="w-7 h-7 animate-spin text-neon-purple" />
          <div className="text-center">
            <div className="text-sm text-white/80 font-medium">
              {progress?.phase === "fetching" && `Загружаю историю токена… ${progress.fetched.toLocaleString()} трейдов`}
              {progress?.phase === "classifying" && `Классифицирую кошельки… (${progress.fetched.toLocaleString()} трейдов)`}
              {progress?.phase === "enriching" && "Получаю балансы и статус кошельков…"}
              {!progress && "Подключаюсь к Pump.fun…"}
            </div>
            {/* Elapsed time + ETA */}
            {startedAt && (() => {
              void nowTick; // re-render every second
              const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
              const fetched = progress?.fetched ?? 0;
              const target = 3000;
              let etaText = "";
              if (progress?.phase === "fetching" && fetched > 50 && fetched < target) {
                const rate = fetched / Math.max(1, elapsedSec); // trades/sec
                const etaSec = Math.ceil((target - fetched) / rate);
                etaText = ` · осталось ~${etaSec}с`;
              }
              const mins = Math.floor(elapsedSec / 60);
              const secs = elapsedSec % 60;
              const elapsedText = mins > 0 ? `${mins}м ${secs}с` : `${secs}с`;
              return (
                <div className="mt-1 text-[11px] text-white/40">
                  Прошло {elapsedText}{etaText}
                </div>
              );
            })()}
            {progress?.phase === "fetching" && (
              <div className="mt-2 w-64 h-1.5 bg-white/5 rounded-full overflow-hidden">
                <div
                  className="h-full bg-neon-purple transition-all"
                  style={{ width: `${Math.min(100, (progress.fetched / 3000) * 100)}%` }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Results */}
      {data && !isLoading && <AnalysisResults data={data} />}
    </div>
  );
}

type SortKey = "pnl" | "volume";
type SortDir = "asc" | "desc";

type DetailPanel = null | "trades" | "wallets" | "bundles";

function AnalysisResults({ data }: { data: AnalysisData }) {
  const [filters, setFilters] = useState<TradeFilters>(DEFAULT_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>("pnl");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [openPanel, setOpenPanel] = useState<DetailPanel>(null);
  const stateKey = `${ANALYSIS_RESULTS_STATE_PREFIX}${data.mint}`;
  const [hasRestoredState, setHasRestoredState] = useState(false);

  useEffect(() => {
    const restored = loadPageState<AnalysisResultsViewState | null>(stateKey, null);
    if (!restored) {
      setFilters(DEFAULT_FILTERS);
      setSortKey("pnl");
      setSortDir("desc");
      setOpenPanel(null);
      return;
    }
    setFilters(restored.filters ?? DEFAULT_FILTERS);
    setSortKey(restored.sortKey ?? "pnl");
    setSortDir(restored.sortDir ?? "desc");
    setOpenPanel(restored.openPanel ?? null);
    setHasRestoredState(true);
  }, [stateKey]);

  useEffect(() => {
    if (!hasRestoredState) return;
    savePageState<AnalysisResultsViewState>(stateKey, {
      filters,
      sortKey,
      sortDir,
      openPanel,
    });
  }, [stateKey, hasRestoredState, filters, sortKey, sortDir, openPanel]);

  useEffect(() => {
    if (loadPageState<AnalysisResultsViewState | null>(stateKey, null)) return;
    setHasRestoredState(true);
  }, [stateKey]);

  const wallets = data.wallets as unknown as WalletRowData[];

  const filtered = useMemo(() => {
    const list = wallets.filter((w) => {
      if (filters.showFresh && !w.isFresh) return false;
      if (filters.showSmart && !w.isSmart) return false;
      if (filters.showBundled && !w.bundleId) return false;
      if (filters.showWash && !w.isWashTrader) return false;
      const balanceUsd = (w.solBalance ?? 0) * 150 + w.tokenBalanceUsd; // rough SOL→USD
      if (filters.minBalanceUsd > 0 && balanceUsd < filters.minBalanceUsd) return false;
      if (filters.search && !w.address.toLowerCase().includes(filters.search.toLowerCase()))
        return false;
      return true;
    });
    // Sort
    list.sort((a, b) => {
      const av = sortKey === "pnl" ? a.pnlSol : a.volumeSol;
      const bv = sortKey === "pnl" ? b.pnlSol : b.volumeSol;
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return list;
  }, [wallets, filters, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const exportCsv = useCallback(() => {
    const headers = [
      "address",
      "buys",
      "sells",
      "volumeSol",
      "pnlSol",
      "pnlPercent",
      "solBalance",
      "isFresh",
      "isSmart",
      "isWashTrader",
      "bundleId",
      "relatedCount",
    ];
    const rows = filtered.map((w) =>
      [
        w.address,
        w.buys,
        w.sells,
        w.volumeSol.toFixed(6),
        w.pnlSol.toFixed(6),
        w.pnlPercent.toFixed(2),
        (w.solBalance ?? 0).toFixed(6),
        w.isFresh,
        w.isSmart,
        w.isWashTrader,
        w.bundleId ?? "",
        w.relatedCount,
      ].join(",")
    );
    const blob = new Blob([headers.join(",") + "\n" + rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `analysis-${data.mint.slice(0, 8)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered, data.mint]);

  return (
    <div className="space-y-4">
      {/* Token info card */}
      <TokenInfo mint={data.mint} />

      {/* Live chart with DEV / Bundle markers */}
      <PumpFunChart mint={data.mint} />

      {/* Summary — clickable cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Volume" value={`${data.summary.totalVolumeSol.toFixed(2)} SOL`} />
        <Stat
          label="Trades"
          value={data.summary.totalTrades.toLocaleString()}
          active={openPanel === "trades"}
          onClick={() => setOpenPanel((p) => (p === "trades" ? null : "trades"))}
          hint="Самые активные кошельки"
        />
        <Stat
          label="Unique Wallets"
          value={data.summary.uniqueWallets.toLocaleString()}
          active={openPanel === "wallets"}
          onClick={() => setOpenPanel((p) => (p === "wallets" ? null : "wallets"))}
          hint="Топ прибыльных"
        />
        <Stat
          label="Bundles"
          value={data.bundles.length.toString()}
          active={openPanel === "bundles"}
          onClick={() => data.bundles.length > 0 && setOpenPanel((p) => (p === "bundles" ? null : "bundles"))}
          hint="Группы кошельков"
          disabled={data.bundles.length === 0}
        />
      </div>

      {/* Detail panel */}
      {openPanel && (
        <DetailPanelView
          panel={openPanel}
          wallets={wallets}
          bundles={data.bundles}
          trades={data.trades}
          onClose={() => setOpenPanel(null)}
        />
      )}

      {/* Period info */}
      {data.summary.periodStart && data.summary.periodEnd && (
        <div className="text-xs text-white/40 flex flex-wrap gap-x-3 gap-y-1">
          <span>
            <span className="text-white/30">Период:</span>{" "}
            <span className="text-white/70">
              {new Date(data.summary.periodStart * 1000).toLocaleString()}
            </span>{" → "}
            <span className="text-white/70">
              {new Date(data.summary.periodEnd * 1000).toLocaleString()}
            </span>
          </span>
          <span>
            <span className="text-white/30">Продолжительность:</span>{" "}
            <span className="text-white/70">
              {formatDuration(data.summary.periodEnd - data.summary.periodStart)}
            </span>
          </span>
          {data.summary.totalRawTrades && data.summary.totalRawTrades !== data.summary.totalTrades && (
            <span className="text-warning">
              Сырых трейдов: {data.summary.totalRawTrades.toLocaleString()}
            </span>
          )}
        </div>
      )}

      {/* DEV Analysis */}
      <DevAnalysis mint={data.mint} />

      {/* Filters */}
      <FiltersPanel
        filters={filters}
        onChange={setFilters}
        walletsCount={wallets.length}
        filteredCount={filtered.length}
      />

      {/* Wallets list */}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-white">
          Wallets ({filtered.length.toLocaleString()})
        </h3>

        <div className="flex items-center gap-1 ml-2">
          <span className="text-[10px] uppercase tracking-wider text-white/40">Сортировка:</span>
          <SortButton
            label="PnL"
            active={sortKey === "pnl"}
            dir={sortKey === "pnl" ? sortDir : null}
            onClick={() => toggleSort("pnl")}
          />
          <SortButton
            label="Volume"
            active={sortKey === "volume"}
            dir={sortKey === "volume" ? sortDir : null}
            onClick={() => toggleSort("volume")}
          />
        </div>

        <button
          type="button"
          onClick={exportCsv}
          disabled={filtered.length === 0}
          className="ml-auto px-3 py-1.5 rounded-md bg-white/5 border border-bg-border text-xs text-white/70 hover:text-white flex items-center gap-1.5 disabled:opacity-40"
        >
          <Download className="w-3.5 h-3.5" />
          Export CSV
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="glass rounded-xl border border-bg-border p-6 text-center text-sm text-white/40">
          Нет кошельков, соответствующих фильтрам
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.slice(0, 200).map((w) => (
            <WalletRow key={w.address} w={w} allTrades={data.trades} />
          ))}
          {filtered.length > 200 && (
            <div className="text-center text-xs text-white/40 py-2">
              Показано 200 из {filtered.length}. Используй CSV экспорт для полного списка.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SortButton({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-tag={`trade.sort_${label.toLowerCase()}`}
      className={
        "px-2.5 py-1 rounded-md text-xs font-medium border flex items-center gap-1 transition " +
        (active
          ? "bg-neon-purple/15 border-neon-purple/40 text-neon-purple"
          : "bg-white/5 border-bg-border text-white/55 hover:text-white")
      }
      title={`Сортировка по ${label} (${dir === "asc" ? "возрастание" : dir === "desc" ? "убывание" : "клик для активации"})`}
    >
      {label}
      {active && (dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
    </button>
  );
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}с`;
  if (sec < 3600) return `${Math.floor(sec / 60)} мин`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} ч`;
  return `${(sec / 86400).toFixed(1)} дн`;
}

function Stat({
  label,
  value,
  hint,
  active,
  disabled,
  onClick,
}: {
  label: string;
  value: string;
  hint?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const clickable = !!onClick && !disabled;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`glass rounded-lg border px-4 py-3 text-left w-full transition-all ${
        active
          ? "border-neon-purple/50 bg-neon-purple/5"
          : clickable
          ? "border-bg-border hover:border-neon-purple/30 hover:bg-white/5 cursor-pointer"
          : "border-bg-border cursor-default"
      } disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:border-bg-border`}
    >
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="text-base font-semibold text-white mt-0.5">{value}</div>
      {hint && clickable && (
        <div className="text-[10px] text-neon-purple/70 mt-1">→ {hint}</div>
      )}
    </button>
  );
}

// ── Detail panels for clickable summary cards ────────────────
function DetailPanelView({
  panel,
  wallets,
  bundles,
  trades,
  onClose,
}: {
  panel: "trades" | "wallets" | "bundles";
  wallets: WalletRowData[];
  bundles: { id: string; size: number; totalVolumeSol: number; wallets: string[] }[];
  trades: CompactTrade[];
  onClose: () => void;
}) {
  const title =
    panel === "trades" ? "Самые активные кошельки" :
    panel === "wallets" ? "Топ прибыльных кошельков" :
    "Группы (bundles)";

  return (
    <div className="glass rounded-xl border border-neon-purple/30 p-4 animate-in fade-in duration-200">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <button
          onClick={onClose}
          className="text-white/40 hover:text-white text-xs px-2 py-1 rounded hover:bg-white/5"
        >
          ✕ Закрыть
        </button>
      </div>

      {panel === "trades" && <TopActiveWallets wallets={wallets} />}
      {panel === "wallets" && <TopProfitableWallets wallets={wallets} />}
      {panel === "bundles" && <TopBundles bundles={bundles} wallets={wallets} trades={trades} />}
    </div>
  );
}

function TopActiveWallets({ wallets }: { wallets: WalletRowData[] }) {
  const top = useMemo(() => {
    return [...wallets]
      .map((w) => ({ ...w, totalTrades: w.buys + w.sells }))
      .sort((a, b) => b.totalTrades - a.totalTrades)
      .slice(0, 20);
  }, [wallets]);

  return (
    <div className="space-y-1">
      {top.map((w, i) => (
        <div key={w.address} className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-white/5 text-xs">
          <span className="text-white/30 w-6">#{i + 1}</span>
          <span className="font-mono text-white/80 flex-1 truncate">{w.address.slice(0, 8)}…{w.address.slice(-6)}</span>
          <span className="text-white">{w.totalTrades} трейдов</span>
          <span className="text-white/50">({w.buys}B / {w.sells}S)</span>
          <span className={w.pnlSol >= 0 ? "text-success" : "text-neon-red"}>
            {w.pnlSol >= 0 ? "+" : ""}{w.pnlSol.toFixed(2)} SOL
          </span>
        </div>
      ))}
    </div>
  );
}

function TopProfitableWallets({ wallets }: { wallets: WalletRowData[] }) {
  const top = useMemo(() => {
    return [...wallets]
      .filter((w) => w.pnlSol > 0)
      .sort((a, b) => b.pnlSol - a.pnlSol)
      .slice(0, 20);
  }, [wallets]);

  if (top.length === 0) {
    return <div className="text-xs text-white/40 py-4 text-center">Нет прибыльных кошельков</div>;
  }
  return (
    <div className="space-y-1">
      {top.map((w, i) => (
        <div key={w.address} className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-white/5 text-xs">
          <span className="text-white/30 w-6">#{i + 1}</span>
          <span className="font-mono text-white/80 flex-1 truncate">{w.address.slice(0, 8)}…{w.address.slice(-6)}</span>
          <span className="text-success font-semibold">+{w.pnlSol.toFixed(3)} SOL</span>
          <span className="text-white/50">({w.pnlPercent >= 0 ? "+" : ""}{w.pnlPercent.toFixed(1)}%)</span>
          <span className="text-white/60">{w.volumeSol.toFixed(1)} vol</span>
          {w.bundleId && <span className="text-neon-purple text-[10px]">📦 {w.bundleId.slice(0, 6)}</span>}
        </div>
      ))}
    </div>
  );
}

function TopBundles({
  bundles,
  wallets,
  trades,
}: {
  bundles: { id: string; size: number; totalVolumeSol: number; wallets: string[] }[];
  wallets: WalletRowData[];
  trades: CompactTrade[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const enriched = useMemo(() => {
    const walletMap = new Map(wallets.map((w) => [w.address, w]));
    return bundles
      .map((b) => {
        const totalPnl = b.wallets.reduce((s, addr) => s + (walletMap.get(addr)?.pnlSol ?? 0), 0);
        return { ...b, totalPnl };
      })
      .sort((a, b) => b.totalVolumeSol - a.totalVolumeSol)
      .slice(0, 20);
  }, [bundles, wallets]);

  return (
    <div className="space-y-2">
      {enriched.map((b, i) => {
        const isOpen = expanded === b.id;
        return (
          <div key={b.id} className="rounded-md bg-white/5 border border-bg-border overflow-hidden">
            <button
              type="button"
              onClick={() => setExpanded(isOpen ? null : b.id)}
              className={`w-full text-left px-3 py-2 text-xs transition ${
                isOpen ? "bg-neon-purple/10 border-b border-neon-purple/30" : "hover:bg-white/5"
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="text-white/30 w-6">#{i + 1}</span>
                <span className="font-mono text-neon-purple">📦 {b.id}</span>
                <span className="text-white/60">{b.size} кошельков</span>
                <span className="text-white">{b.totalVolumeSol.toFixed(2)} SOL объём</span>
                <span className={`ml-auto ${b.totalPnl >= 0 ? "text-success" : "text-neon-red"}`}>
                  {b.totalPnl >= 0 ? "+" : ""}{b.totalPnl.toFixed(2)} SOL PnL
                </span>
                <span className="text-white/30 text-[10px]">{isOpen ? "▲ скрыть" : "▼ график"}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {b.wallets.slice(0, 8).map((addr) => (
                  <span key={addr} className="px-1.5 py-0.5 rounded bg-white/5 text-[10px] font-mono text-white/60">
                    {addr.slice(0, 6)}…{addr.slice(-4)}
                  </span>
                ))}
                {b.wallets.length > 8 && (
                  <span className="px-1.5 py-0.5 text-[10px] text-white/40">+{b.wallets.length - 8}</span>
                )}
              </div>
            </button>

            {isOpen && (
              <div className="p-3 bg-bg/40">
                <BundleChart trades={trades} bundleWallets={new Set(b.wallets)} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Bundle chart: shows all token trades + highlights bundle members' trades ──
function BundleChart({
  trades,
  bundleWallets,
}: {
  trades: CompactTrade[];
  bundleWallets: Set<string>;
}) {
  const W = 800;
  const H = 220;
  const PAD = { top: 10, right: 8, bottom: 18, left: 56 };
  const SOL_USD = 150;
  const PUMP_SUPPLY = 1_000_000_000;
  const fmtMC = (usd: number) => {
    if (usd >= 1e9) return `$${(usd / 1e9).toFixed(2)}B`;
    if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M`;
    if (usd >= 1e3) return `$${(usd / 1e3).toFixed(1)}k`;
    return `$${usd.toFixed(0)}`;
  };
  const fmtTime = (s: number) =>
    new Date(s * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  const [hover, setHover] = useState<{ trade: CompactTrade; x: number; y: number } | null>(null);

  const sorted = useMemo(() => [...trades].sort((a, b) => a.ts - b.ts), [trades]);
  if (sorted.length < 2) {
    return <div className="text-xs text-white/40 text-center py-6">Недостаточно данных для графика</div>;
  }

  const minTs = sorted[0].ts;
  const maxTs = sorted[sorted.length - 1].ts;
  const tsRange = Math.max(1, maxTs - minTs);
  const prices = sorted.map((t) => t.p);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const pRange = Math.max(maxP - minP, maxP * 0.001 || 1e-12);

  const xOf = (ts: number) => PAD.left + ((ts - minTs) / tsRange) * (W - PAD.left - PAD.right);
  const yOf = (p: number) => PAD.top + (1 - (p - minP) / pRange) * (H - PAD.top - PAD.bottom);

  const pathD = sorted.map((t, i) => `${i === 0 ? "M" : "L"}${xOf(t.ts).toFixed(1)},${yOf(t.p).toFixed(1)}`).join(" ");
  const bundleTrades = sorted.filter((t) => bundleWallets.has(t.w));
  const bundleBuys = bundleTrades.filter((t) => t.t === 1).length;
  const bundleSells = bundleTrades.filter((t) => t.t === 0).length;
  const bundleSolVolume = bundleTrades.reduce((s, t) => s + t.s, 0);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const p = minP + f * pRange;
    return { y: yOf(p), label: fmtMC(p * SOL_USD * PUMP_SUPPLY) };
  });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-[10px] text-white/60">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-success" /> BUY
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-neon-red" /> SELL
        </span>
        <span className="ml-2 text-white/80">
          {bundleTrades.length} трейдов · {bundleBuys}B / {bundleSells}S · {bundleSolVolume.toFixed(2)} SOL
        </span>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-52" onMouseLeave={() => setHover(null)}>
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
              <text x={PAD.left - 4} y={t.y + 3} textAnchor="end" fontSize={9} fill="rgba(255,255,255,0.4)">
                {t.label}
              </text>
            </g>
          ))}
          <path d={pathD} fill="none" stroke="rgba(168,85,247,0.4)" strokeWidth={1} />

          {bundleTrades.map((t) => {
            const cx = xOf(t.ts);
            const cy = yOf(t.p);
            const isBuy = t.t === 1;
            const r = Math.max(4, Math.min(11, Math.sqrt(t.s) * 5));
            const isHover = hover?.trade.sig === t.sig;
            return (
              <g
                key={t.sig}
                onMouseEnter={() => setHover({ trade: t, x: cx, y: cy })}
                style={{ cursor: "pointer" }}
              >
                <circle cx={cx} cy={cy} r={Math.max(r + 4, 12)} fill="transparent" />
                <circle
                  cx={cx} cy={cy}
                  r={isHover ? r + 2 : r}
                  fill={isBuy ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)"}
                  stroke={isHover ? "#fff" : isBuy ? "#22c55e" : "#ef4444"}
                  strokeWidth={isHover ? 2 : 1.5}
                  style={{ transition: "all 120ms" }}
                />
              </g>
            );
          })}

          {hover && (
            <line
              x1={hover.x} x2={hover.x}
              y1={PAD.top} y2={H - PAD.bottom}
              stroke="rgba(255,255,255,0.15)"
              strokeDasharray="3 3"
              strokeWidth={1}
              pointerEvents="none"
            />
          )}

          <text x={PAD.left} y={H - 4} fontSize={9} fill="rgba(255,255,255,0.4)">{fmtTime(minTs)}</text>
          <text x={W - PAD.right} y={H - 4} fontSize={9} fill="rgba(255,255,255,0.4)" textAnchor="end">
            {fmtTime(maxTs)}
          </text>
        </svg>

        {hover && (
          <div
            className="absolute pointer-events-none z-10"
            style={{
              left: `calc(${(hover.x / W) * 100}% + 8px)`,
              top: `calc(${(hover.y / H) * 100}% - 4px)`,
              transform: hover.x > W * 0.7 ? "translate(calc(-100% - 16px), -100%)" : "translateY(-100%)",
            }}
          >
            <div
              className={`min-w-[180px] rounded-lg border backdrop-blur-md shadow-2xl px-3 py-2 text-xs ${
                hover.trade.t === 1 ? "border-success/40" : "border-neon-red/40"
              }`}
              style={{ background: hover.trade.t === 1 ? "rgba(8,28,18,0.92)" : "rgba(36,12,15,0.92)" }}
            >
              <div className="flex items-center justify-between gap-2 pb-1 border-b border-white/10">
                <span className={`font-bold uppercase text-[10px] ${hover.trade.t === 1 ? "text-success" : "text-neon-red"}`}>
                  {hover.trade.t === 1 ? "● BUY" : "● SELL"}
                </span>
                <span className="text-white/40 text-[9px]">{fmtTime(hover.trade.ts)}</span>
              </div>
              <div className="pt-1.5 space-y-1">
                <div>
                  <div className="text-[9px] text-white/40 uppercase">Market Cap</div>
                  <div className="text-sm font-bold text-white">{fmtMC(hover.trade.p * SOL_USD * PUMP_SUPPLY)}</div>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1 border-t border-white/10">
                  <div>
                    <div className="text-[9px] text-white/40">SOL</div>
                    <div className="text-[11px] font-mono text-white">{hover.trade.s.toFixed(4)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[9px] text-white/40">Wallet</div>
                    <div className="text-[10px] font-mono text-neon-purple">{hover.trade.w.slice(0, 4)}…{hover.trade.w.slice(-4)}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
