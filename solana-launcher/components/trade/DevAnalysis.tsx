"use client";
// data-tag: components.trade.dev_analysis

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, UserCheck, Bookmark, Copy, ExternalLink, ArrowUpDown, ChevronDown, ChevronUp, Wallet, Coins } from "lucide-react";
import dynamic from "next/dynamic";
import { authHeaders } from "@/lib/clientAuth";

const DevForensicsPanel = dynamic(() => import("./DevForensicsPanel"), { ssr: false, loading: () => (
  <div className="flex items-center gap-2 text-xs text-white/40 py-2"><Loader2 className="w-3 h-3 animate-spin" />Загружаю forensics…</div>
) });

interface DevToken {
  mint: string;
  symbol: string;
  name: string;
  createdAt: number | null;
  marketCapUsd: number | null;
  athUsd: number | null;
  isMigrated: boolean;
  reached300k: boolean;
}

interface DevAnalysisData {
  address: string;
  totalTokensCreated: number;
  tokens: DevToken[];
  migratedCount: number;
  migrationRate: number;
  reached300kCount: number;
  rate300k: number;
  bestLaunchHourUtc: number | null;
  launchesByHour: number[];
  userTag: string | null;
  userNote: string | null;
  // Risk metrics (optional — server may not always populate)
  riskScore?: number;
  riskLevel?: "low" | "medium" | "high" | "critical";
  riskReasons?: string[];
  rugRate?: number;
  successRate?: number;
  avgMcUsd?: number | null;
  medianMcUsd?: number | null;
  maxMcUsd?: number | null;
  minTimeBetweenLaunchesSec?: number | null;
  avgTimeBetweenLaunchesSec?: number | null;
  daysSinceLastLaunch?: number | null;
  bestToken?: { mint: string; symbol: string; mcUsd: number } | null;
  worstToken?: { mint: string; symbol: string; mcUsd: number } | null;
  degraded?: boolean;
  warning?: string | null;
  sourceMint?: string | null;
}

const RISK_COLORS: Record<string, { bg: string; text: string; border: string; label: string }> = {
  low:      { bg: "bg-green-500/15",  text: "text-green-400",  border: "border-green-500/30",  label: "Низкий" },
  medium:   { bg: "bg-yellow-500/15", text: "text-yellow-400", border: "border-yellow-500/30", label: "Средний" },
  high:     { bg: "bg-orange-500/15", text: "text-orange-400", border: "border-orange-500/30", label: "Высокий" },
  critical: { bg: "bg-red-500/15",    text: "text-red-400",    border: "border-red-500/30",    label: "Критический" },
};

function fmtMcUsd(v: number | null | undefined): string {
  if (v == null || v === 0) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}с`;
  if (sec < 3600) return `${Math.floor(sec / 60)}м`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}ч`;
  return `${Math.floor(sec / 86400)}д`;
}

function getTokenMc(token: DevToken): number {
  return Math.max(token.marketCapUsd ?? 0, token.athUsd ?? 0, 0);
}

function normalizeRate(value: number): number {
  return value > 1 ? value / 100 : value;
}

function buildAnalysisFromWallet(payload: any, mint: string): DevAnalysisData | null {
  const wallet = payload?.wallet;
  const tokens = Array.isArray(payload?.tokens) ? payload.tokens : [];
  const address = payload?.address || wallet?.address;
  if (!address) return null;

  const mappedTokens: DevToken[] = tokens.map((token: any) => ({
    mint: token.mint,
    symbol: token.symbol || "",
    name: token.name || "",
    createdAt: token.createdAt ?? null,
    marketCapUsd: token.marketCapUsd ?? null,
    athUsd: token.athUsd ?? null,
    isMigrated: Boolean(token.isMigrated),
    reached300k: Boolean(token.reached300k),
  }));

  const totalTokensCreated = wallet?.totalTokens ?? mappedTokens.length;
  const migratedCount = wallet?.migratedCount ?? mappedTokens.filter((token) => token.isMigrated).length;
  const reached300kCount = wallet?.reached300kCount ?? mappedTokens.filter((token) => token.reached300k).length;
  const migrationRate = normalizeRate(wallet?.migrationRate ?? (totalTokensCreated > 0 ? migratedCount / totalTokensCreated : 0));
  const rate300k = normalizeRate(wallet?.rate300k ?? (totalTokensCreated > 0 ? reached300kCount / totalTokensCreated : 0));
  const bestLaunchHourUtc = typeof wallet?.bestLaunchHour === "number" ? wallet.bestLaunchHour : null;

  return {
    address,
    totalTokensCreated,
    tokens: mappedTokens,
    migratedCount,
    migrationRate,
    reached300kCount,
    rate300k,
    bestLaunchHourUtc,
    launchesByHour: Array.from({ length: 24 }, () => 0),
    userTag: payload?.userTag ?? null,
    userNote: payload?.userNote ?? null,
    degraded: true,
    warning: payload?.warning ?? `Показаны сохранённые данные кошелька для mint ${mint}`,
    avgMcUsd: wallet?.avgMcUsd ?? null,
    medianMcUsd: null,
    maxMcUsd: wallet?.maxMcUsd ?? null,
    minTimeBetweenLaunchesSec: null,
    avgTimeBetweenLaunchesSec: null,
    daysSinceLastLaunch: null,
    bestToken: mappedTokens.length > 0
      ? (() => {
          const best = mappedTokens.reduce((bestToken, token) => {
            return getTokenMc(token) > getTokenMc(bestToken) ? token : bestToken;
          }, mappedTokens[0]);
          return { mint: best.mint, symbol: best.symbol || best.mint.slice(0, 6), mcUsd: getTokenMc(best) };
        })()
      : null,
    worstToken: mappedTokens.length > 0
      ? (() => {
          const worst = mappedTokens.reduce((worstToken, token) => {
            return getTokenMc(token) < getTokenMc(worstToken) ? token : worstToken;
          }, mappedTokens[0]);
          return { mint: worst.mint, symbol: worst.symbol || worst.mint.slice(0, 6), mcUsd: getTokenMc(worst) };
        })()
      : null,
    riskScore: payload?.riskScore,
    riskLevel: payload?.riskLevel,
    riskReasons: payload?.riskReasons,
    sourceMint: payload?.sourceMint ?? mint,
  };
}

async function fetchWalletFallback(mint: string): Promise<DevAnalysisData | null> {
  const walletRes = await fetch(`/api/trade/dev-wallet?mint=${encodeURIComponent(mint)}&tokens=1`, { cache: "no-store" });
  const walletJson = await walletRes.json().catch(() => null);
  return buildAnalysisFromWallet(walletJson, mint);
}

export default function DevAnalysis({ mint }: { mint: string }) {
  const [data, setData] = useState<DevAnalysisData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [savingTag, setSavingTag] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  const [sortByMcAsc, setSortByMcAsc] = useState(false);
  const [onlyMigrated, setOnlyMigrated] = useState(false);
  const [showWallets, setShowWallets] = useState(false);
  const [showTokens, setShowTokens] = useState(true); // по умолчанию показываем

  const fetchDev = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const initialFallback = await fetchWalletFallback(mint).catch(() => null);
      if (initialFallback) {
        setData(initialFallback);
        setTagInput(initialFallback.userTag ?? "");
        setLoading(false);
      }

      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 8_000);
      const r = await fetch(`/api/trade/dev?mint=${encodeURIComponent(mint)}`, { cache: "no-store", signal: controller.signal });
      window.clearTimeout(timeoutId);
      const json = await r.json().catch(() => null);
      if (r.ok && json?.address) {
        setData(json);
        setTagInput(json.userTag ?? "");
      } else {
        const fallback = initialFallback ?? await fetchWalletFallback(mint);

        if (fallback) {
          setData(fallback);
          setTagInput(fallback.userTag ?? "");
          setError(null);
        } else {
          setError(json?.error || `HTTP ${r.status}`);
          setData(null);
        }
      }
    } catch (e) {
      const fallback = await fetchWalletFallback(mint).catch(() => null);
      if (fallback) {
        setData(fallback);
        setTagInput(fallback.userTag ?? "");
        setError(null);
      } else {
        setError((e as Error).name === "AbortError" ? "DEV-анализ не ответил вовремя, сохранённых данных нет" : (e as Error).message);
        setData(null);
      }
    } finally {
      setLoading(false);
    }
  }, [mint]);

  useEffect(() => {
    fetchDev();
  }, [fetchDev]);

  const saveTag = useCallback(async () => {
    if (!data?.address) return;
    setSavingTag(true);
    setTagError(null);
    try {
      if (tagInput.trim()) {
        const r = await fetch("/api/trade/dev-tag", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ address: data.address, tag: tagInput.trim() }),
        });
        const json = await r.json();
        if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
        setData({ ...data, userTag: json.tag?.tag ?? tagInput.trim() });
      } else {
        // Delete tag
        await fetch(`/api/trade/dev-tag?address=${encodeURIComponent(data.address)}`, {
          method: "DELETE",
          headers: authHeaders(),
        });
        setData({ ...data, userTag: null });
      }
    } catch (e) {
      setTagError(`Tag save failed: ${(e as Error).message}`);
    } finally {
      setSavingTag(false);
    }
  }, [data, tagInput]);

  const sortedTokens = useMemo(() => {
    if (!data) return [];
    let list = [...data.tokens];
    if (onlyMigrated) list = list.filter((t) => t.isMigrated);
    list.sort((a, b) => {
      const av = a.marketCapUsd ?? 0;
      const bv = b.marketCapUsd ?? 0;
      return sortByMcAsc ? av - bv : bv - av;
    });
    return list;
  }, [data, sortByMcAsc, onlyMigrated]);

  if (loading) {
    return (
      <div className="glass rounded-xl border border-bg-border p-6 flex items-center gap-3">
        <Loader2 className="w-4 h-4 animate-spin text-neon-purple" />
        <span className="text-sm text-white/60">Анализирую DEV кошелёк…</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="glass rounded-xl border border-bg-border p-4 text-sm text-white/50">
        DEV-анализ: {error ?? "нет данных"}
      </div>
    );
  }

  const short = `${data.address.slice(0, 6)}…${data.address.slice(-4)}`;
  const isDegraded = Boolean(data.degraded);

  return (
    <div className="glass rounded-xl border border-bg-border p-4 space-y-4" data-tag="trade.dev_analysis">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-neon-purple/15 border border-neon-purple/30 flex items-center justify-center">
          <UserCheck className="w-5 h-5 text-neon-purple" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">DEV Analysis</span>
            {data.userTag && (
              <span className="px-2 py-0.5 rounded bg-neon-purple/15 border border-neon-purple/30 text-[10px] font-bold text-neon-purple">
                <Bookmark className="w-3 h-3 inline mr-0.5" />
                {data.userTag}
              </span>
            )}
            {isDegraded && (
              <span className="px-2 py-0.5 rounded bg-yellow-500/15 border border-yellow-500/30 text-[10px] font-bold text-yellow-300">
                Fallback
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 mt-0.5">
            <span className="text-xs font-mono text-white/50">{short}</span>
            <button
              onClick={() => navigator.clipboard.writeText(data.address)}
              className="text-white/30 hover:text-white"
            >
              <Copy className="w-3 h-3" />
            </button>
            <a
              href={`https://solscan.io/account/${data.address}`}
              target="_blank"
              rel="noreferrer"
              className="text-white/30 hover:text-white"
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          {data.warning && (
            <div className="mt-1 text-[11px] text-yellow-300/80">
              {data.warning}
            </div>
          )}
        </div>
      </div>

      {/* Tag editor */}
      <div className="flex gap-2">
        <input
          type="text"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          placeholder="Подписать DEV (например: RugMaster)"
          maxLength={64}
          className="flex-1 px-3 py-2 rounded-md bg-white/5 border border-bg-border text-xs text-white placeholder:text-white/30 focus:outline-none focus:border-neon-purple/40"
        />
        <button
          type="button"
          onClick={saveTag}
          disabled={savingTag}
          className="px-3 py-2 rounded-md bg-neon-purple/15 border border-neon-purple/30 text-xs font-semibold text-neon-purple hover:bg-neon-purple/25 disabled:opacity-40"
        >
          {savingTag ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Сохранить"}
        </button>
      </div>

      {tagError && (
        <div className="rounded-md border border-[color-mix(in_srgb,var(--theme-danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--theme-danger)_10%,transparent)] px-3 py-2 text-xs text-[color:var(--theme-danger)]" role="alert">
          {tagError}
        </div>
      )}

      {/* Risk Score */}
      {data.riskLevel && data.riskScore !== undefined && (() => {
        const c = RISK_COLORS[data.riskLevel] ?? RISK_COLORS.low;
        return (
          <div className={`rounded-lg border ${c.border} ${c.bg} p-3 space-y-2`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`text-xs uppercase tracking-wider font-bold ${c.text}`}>Risk: {c.label}</span>
                <span className="text-[10px] text-white/40">DEV-кошелька</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-2xl font-bold tabular-nums ${c.text}`}>{data.riskScore}</span>
                <span className="text-xs text-white/40">/100</span>
              </div>
            </div>
            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div className={`h-full ${c.text.replace("text-", "bg-")}`} style={{ width: `${data.riskScore}%` }} />
            </div>
            {data.riskReasons && data.riskReasons.length > 0 && (
              <ul className="text-[11px] text-white/70 space-y-0.5 mt-1">
                {data.riskReasons.slice(0, 5).map((r, i) => (
                  <li key={i} className="flex gap-1.5"><span className="text-white/30">•</span>{r}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })()}

      {/* Risk-derived stats */}
      {(data.rugRate !== undefined || data.successRate !== undefined) && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <StatBox
            label="Rug Rate"
            value={data.rugRate !== undefined ? `${(data.rugRate * 100).toFixed(0)}%` : "—"}
          />
          <StatBox
            label="Success Rate"
            value={data.successRate !== undefined ? `${(data.successRate * 100).toFixed(0)}%` : "—"}
          />
          <StatBox label="Avg MC" value={fmtMcUsd(data.avgMcUsd)} />
          <StatBox label="Best MC" value={fmtMcUsd(data.maxMcUsd)} />
          <StatBox label="Min между запусками" value={fmtDuration(data.minTimeBetweenLaunchesSec)} />
          <StatBox label="Avg между запусками" value={fmtDuration(data.avgTimeBetweenLaunchesSec)} />
          <StatBox
            label="Дней с последнего"
            value={data.daysSinceLastLaunch != null ? `${data.daysSinceLastLaunch}д` : "—"}
          />
          <StatBox
            label="Best Token"
            value={data.bestToken ? `${data.bestToken.symbol || data.bestToken.mint.slice(0, 6)} ${fmtMcUsd(data.bestToken.mcUsd)}` : "—"}
          />
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <StatBox label="Tokens Created" value={data.totalTokensCreated.toString()} />
        <StatBox
          label="Migrated"
          value={`${data.migratedCount} (${(normalizeRate(data.migrationRate) * 100).toFixed(1)}%)`}
        />
        <StatBox
          label="≥ $300K MC"
          value={`${data.reached300kCount} (${(normalizeRate(data.rate300k) * 100).toFixed(1)}%)`}
        />
        <StatBox
          label="Best Launch Hour (UTC)"
          value={data.bestLaunchHourUtc != null ? `${data.bestLaunchHourUtc}:00` : "—"}
        />
      </div>

      {/* Wallets section - expandable */}
      <div className="border border-bg-border rounded-md overflow-hidden">
        <button
          onClick={() => setShowWallets((v) => !v)}
          className="w-full flex items-center justify-between px-3 py-2 bg-white/5 hover:bg-white/10 transition"
        >
          <div className="flex items-center gap-2">
            <Wallet className="w-4 h-4 text-neon-purple" />
            <span className="text-xs font-semibold text-white">Кошелёк DEV</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/40 font-mono">{short}</span>
            {showWallets ? (
              <ChevronUp className="w-4 h-4 text-white/60" />
            ) : (
              <ChevronDown className="w-4 h-4 text-white/60" />
            )}
          </div>
        </button>

        {showWallets && (
          <div className="px-3 py-3 bg-black/20 border-t border-bg-border">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] text-white/40 uppercase">Адрес</span>
            </div>
            <div className="flex items-center gap-2 p-2 rounded bg-white/5">
              <span className="text-xs font-mono text-white flex-1 break-all">{data.address}</span>
              <button
                onClick={() => navigator.clipboard.writeText(data.address)}
                className="text-white/40 hover:text-white p-1"
                title="Копировать"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <a
                href={`https://solscan.io/account/${data.address}`}
                target="_blank"
                rel="noreferrer"
                className="text-white/40 hover:text-neon-purple p-1"
                title="Открыть в Solscan"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
            <div className="mt-3 flex gap-2">
              <a
                href={`https://solscan.io/account/${data.address}`}
                target="_blank"
                rel="noreferrer"
                className="flex-1 px-3 py-2 rounded bg-neon-purple/15 border border-neon-purple/30 text-xs text-neon-purple text-center hover:bg-neon-purple/25 transition"
              >
                Solscan
              </a>
              <a
                href={`https://gmgn.ai/sol/address/${data.address}`}
                target="_blank"
                rel="noreferrer"
                className="flex-1 px-3 py-2 rounded bg-white/5 border border-bg-border text-xs text-white text-center hover:bg-white/10 transition"
              >
                GMGN
              </a>
              <a
                href={`https://birdeye.so/profile/${data.address}?chain=solana`}
                target="_blank"
                rel="noreferrer"
                className="flex-1 px-3 py-2 rounded bg-white/5 border border-bg-border text-xs text-white text-center hover:bg-white/10 transition"
              >
                Birdeye
              </a>
            </div>
          </div>
        )}
      </div>

      {/* Forensics Panel: Twitter, Pie chart, Volume correlation, Shillers */}
      <DevForensicsPanel
        mint={mint}
        symbol={data.tokens[0]?.symbol || ""}
        devAddress={data.address}
      />

      {/* Tokens table - expandable */}
      <div className="border border-bg-border rounded-md overflow-hidden">
        <div
          role="button"
          tabIndex={0}
          onClick={() => setShowTokens((v) => !v)}
          onKeyDown={(e) => e.key === 'Enter' && setShowTokens((v) => !v)}
          className="w-full flex items-center justify-between px-3 py-2 bg-white/5 hover:bg-white/10 transition cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <Coins className="w-4 h-4 text-neon-green" />
            <span className="text-xs font-semibold text-white">Все токены этого DEV</span>
            <span className="text-[10px] text-white/40 px-1.5 py-0.5 rounded bg-white/5">
              {sortedTokens.length}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {showTokens && (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); setSortByMcAsc((v) => !v); }}
                  className="text-[10px] text-white/60 hover:text-white flex items-center gap-1 px-2 py-0.5 rounded bg-white/5 hover:bg-white/10"
                >
                  <ArrowUpDown className="w-3 h-3" />
                  ATH {sortByMcAsc ? "↑" : "↓"}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setOnlyMigrated((v) => !v); }}
                  className={
                    "text-[10px] px-2 py-0.5 rounded border " +
                    (onlyMigrated
                      ? "bg-neon-purple/15 border-neon-purple/30 text-neon-purple"
                      : "bg-white/5 border-bg-border text-white/60")
                  }
                >
                  Только migrated
                </button>
              </>
            )}
            {showTokens ? (
              <ChevronUp className="w-4 h-4 text-white/60 pointer-events-none" />
            ) : (
              <ChevronDown className="w-4 h-4 text-white/60" />
            )}
          </div>
        </div>

        {showTokens && (
          <div className="border-t border-bg-border">
            <div className="rounded-md overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-white/5">
                  <tr className="text-white/50">
                    <th className="px-3 py-2 text-left font-medium">Symbol</th>
                    <th className="px-3 py-2 text-left font-medium">Name</th>
                    <th className="px-3 py-2 text-right font-medium">MC (USD)</th>
                    <th className="px-3 py-2 text-center font-medium">Migrated</th>
                    <th className="px-3 py-2 text-center font-medium">300K</th>
                    <th className="px-3 py-2 text-center font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTokens.slice(0, 50).map((t) => (
                    <tr key={t.mint} className="border-t border-bg-border hover:bg-white/3">
                      <td className="px-3 py-1.5 text-white font-semibold">{t.symbol || "—"}</td>
                      <td className="px-3 py-1.5 text-white/70 truncate max-w-[200px]">{t.name || t.mint.slice(0, 8)}</td>
                      <td className="px-3 py-1.5 text-right text-white/80">
                        {t.marketCapUsd != null ? `$${formatNum(t.marketCapUsd)}` : "—"}
                      </td>
                      <td className="px-3 py-1.5 text-center">{t.isMigrated ? "✅" : "—"}</td>
                      <td className="px-3 py-1.5 text-center">{t.reached300k ? "🎯" : "—"}</td>
                      <td className="px-3 py-1.5 text-center">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(t.mint);
                          }}
                          className="text-white/30 hover:text-white p-1"
                          title={`Копировать: ${t.mint}`}
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sortedTokens.length > 50 && (
                <div className="px-3 py-2 text-center text-[10px] text-white/40 border-t border-bg-border">
                  Показано 50 из {sortedTokens.length}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2 rounded-md bg-white/5 border border-bg-border">
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="text-sm font-semibold text-white mt-0.5">{value}</div>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
