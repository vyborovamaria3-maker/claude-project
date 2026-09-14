"use client";

import { useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";

type HorizonStats = {
  samples: number;
  winRate: number | null;
  avgDirectionalReturnPct: number | null;
  medianDirectionalReturnPct: number | null;
  p25DirectionalReturnPct: number | null;
  p75DirectionalReturnPct: number | null;
  bestDirectionalReturnPct: number | null;
  worstDirectionalReturnPct: number | null;
};

type SignalOutcome = {
  futurePriceUsd: number;
  priceTimestamp: string;
  rawReturnPct: number;
  directionalReturnPct: number;
  netDirectionalReturnPct: number;
  win: boolean;
};

type BacktestSignal = {
  signalType: "accumulation" | "distribution";
  mint: string;
  symbol?: string | null;
  tokenName?: string | null;
  signalAt: string;
  kolCount: number;
  handles: string[];
  baselinePriceUsd: number;
  returns: Record<string, SignalOutcome | null>;
};

type BacktestResponse = {
  status?: string;
  generatedAt?: string;
  coverage?: {
    joinedTradeRows: number;
    uniqueTrades: number;
    tokensWithAttributedTrades: number;
    tokensWithPriceHistory: number;
    signals: number;
    signalsWith24hOutcome: number;
  };
  summary?: {
    byHorizon?: Record<string, HorizonStats>;
    bySignalType?: Record<string, { signals: number; horizons: Record<string, HorizonStats> }>;
  };
  methodology?: {
    attributionBias?: string;
    lookaheadGuard?: string;
    transactionCost?: string;
  };
  signals?: BacktestSignal[];
  error?: string;
};

function percent(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

function since(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

export default function KOLBacktestPanel() {
  const [lookbackDays, setLookbackDays] = useState(90);
  const [minKols, setMinKols] = useState(3);
  const [minConfidence, setMinConfidence] = useState(70);
  const [strictAttributionTime, setStrictAttributionTime] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BacktestResponse | null>(null);

  async function runBacktest() {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      lookbackDays: String(lookbackDays),
      minKols: String(minKols),
      minConfidence: String(minConfidence),
      windowMinutes: "60",
      cooldownMinutes: "60",
      costBps: "50",
      maxSignals: "300",
      strictAttributionTime: strictAttributionTime ? "true" : "false",
    });

    try {
      const response = await fetch(`/api/kols/backtest?${params.toString()}`, { cache: "no-store" });
      const payload = (await response.json()) as BacktestResponse;
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setData(payload);
    } catch (backtestError) {
      setData(null);
      setError(backtestError instanceof Error ? backtestError.message : "Backtest unavailable");
    } finally {
      setLoading(false);
    }
  }

  const horizons = data?.summary?.byHorizon ?? {};
  const signals = data?.signals ?? [];

  return (
    <section
      className={`${siteDesign.page.compactContainerClassName} !pt-0`}
      data-tag="trade.kols_backtest"
    >
      <div className="surface-panel overflow-hidden rounded-2xl border border-bg-border">
        <div className="flex flex-col gap-3 border-b border-bg-border px-4 py-4 sm:px-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-content">
              <BarChart3 className="h-4 w-4 text-[color:var(--theme-secondary)]" />
              KOL Signal Backtest
            </div>
            <p className="mt-1 max-w-3xl text-[11px] leading-5 text-content-muted">
              Историческая проверка accumulation/distribution: сигнал строится только из KOL trades,
              которые уже произошли к моменту trigger. Результат измеряется по будущим token price metrics.
            </p>
          </div>
          <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-300">
            <ShieldCheck className="h-3 w-3" /> no future-price leakage
          </span>
        </div>

        <div className="grid gap-3 border-b border-bg-border p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-[.65fr_.65fr_.75fr_1.2fr_auto] xl:items-end">
          <label className="block min-w-0">
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-content-faint">Lookback</span>
            <select value={lookbackDays} onChange={(event) => setLookbackDays(Number(event.target.value))} className={siteDesign.controls.inputClassName}>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
              <option value={365}>365 days</option>
            </select>
          </label>

          <label className="block min-w-0">
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-content-faint">Min KOLs / 1h</span>
            <select value={minKols} onChange={(event) => setMinKols(Number(event.target.value))} className={siteDesign.controls.inputClassName}>
              <option value={2}>2+</option>
              <option value={3}>3+</option>
              <option value={4}>4+</option>
              <option value={5}>5+</option>
            </select>
          </label>

          <label className="block min-w-0">
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-content-faint">Confidence</span>
            <select value={minConfidence} onChange={(event) => setMinConfidence(Number(event.target.value))} className={siteDesign.controls.inputClassName}>
              <option value={50}>50+</option>
              <option value={70}>70+</option>
              <option value={90}>90+</option>
            </select>
          </label>

          <label className="flex min-h-[42px] items-center gap-2 rounded-xl border border-bg-border bg-bg-elevated px-3 text-xs text-content-muted">
            <input
              type="checkbox"
              checked={strictAttributionTime}
              onChange={(event) => setStrictAttributionTime(event.target.checked)}
              className="h-4 w-4 accent-[color:var(--theme-primary)]"
            />
            <span className="min-w-0">
              <span className="block font-semibold text-content">Strict attribution time</span>
              <span className="block text-[9px] leading-4 text-content-faint">ignore trades before our first attribution timestamp</span>
            </span>
          </label>

          <button
            type="button"
            onClick={() => void runBacktest()}
            disabled={loading}
            className={`${siteDesign.controls.primaryActionClassName} w-full xl:w-auto`}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
            Run backtest
          </button>
        </div>

        {error ? (
          <div className="m-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger sm:m-5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        ) : null}

        {!data && !error ? (
          <div className="px-4 py-6 text-center text-xs text-content-muted sm:px-5">
            Запусти backtest после того, как в локальной базе накопились `wallet_trades` и `token_metrics`.
          </div>
        ) : null}

        {data?.status === "ok" ? (
          <div className="space-y-5 p-4 sm:p-5">
            <div className="grid gap-3 sm:grid-cols-3">
              {(["1h", "6h", "24h"] as const).map((key) => {
                const stats = horizons[key];
                return (
                  <div key={key} className="rounded-xl border border-bg-border bg-bg-elevated/40 p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-content-faint">{key} outcome</span>
                      <span className="font-mono text-[10px] text-content-muted">n={stats?.samples ?? 0}</span>
                    </div>
                    <div className="mt-2 text-2xl font-semibold text-content">
                      {stats?.winRate == null ? "—" : `${stats.winRate.toFixed(1)}%`}
                    </div>
                    <div className="mt-0.5 text-[10px] text-content-muted">directional win rate after 50 bps cost</div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
                      <div>
                        <div className="text-content-faint">Median</div>
                        <div className="mt-0.5 font-mono text-content">{percent(stats?.medianDirectionalReturnPct)}</div>
                      </div>
                      <div>
                        <div className="text-content-faint">Average</div>
                        <div className="mt-0.5 font-mono text-content">{percent(stats?.avgDirectionalReturnPct)}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <CoverageCard label="Unique trades" value={data.coverage?.uniqueTrades ?? 0} />
              <CoverageCard label="Tokens" value={data.coverage?.tokensWithAttributedTrades ?? 0} />
              <CoverageCard label="Signals" value={data.coverage?.signals ?? 0} />
              <CoverageCard label="24h outcomes" value={data.coverage?.signalsWith24hOutcome ?? 0} />
            </div>

            <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-[10px] leading-5 text-content-muted">
              <span className="font-semibold text-amber-300">Bias note:</span>{" "}
              {data.methodology?.attributionBias || "Current attribution can bias historical coverage."}
              {data.methodology?.lookaheadGuard ? ` ${data.methodology.lookaheadGuard}.` : ""}
            </div>

            {signals.length ? (
              <div className="overflow-hidden rounded-xl border border-bg-border">
                <div className="flex items-center justify-between gap-3 border-b border-bg-border bg-bg-elevated/50 px-3 py-2.5">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-content-faint">Recent historical signals</div>
                  <div className="text-[10px] text-content-muted">latest {Math.min(signals.length, 20)}</div>
                </div>
                <div className="divide-y divide-bg-border">
                  {signals.slice(0, 20).map((signal) => {
                    const outcome = signal.returns["24h"];
                    const isAccumulation = signal.signalType === "accumulation";
                    return (
                      <div
                        key={`${signal.signalType}:${signal.mint}:${signal.signalAt}`}
                        className="grid gap-2 px-3 py-3 text-xs md:grid-cols-[1fr_.65fr_.65fr_.45fr] md:items-center"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[9px] font-semibold uppercase ${isAccumulation ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : "border-danger/30 bg-danger/10 text-danger"}`}>
                              {isAccumulation ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                              {signal.signalType}
                            </span>
                            <span className="truncate font-semibold text-content">{signal.symbol || signal.tokenName || "Unknown token"}</span>
                          </div>
                          <div className="mt-1 truncate font-mono text-[9px] text-content-faint">{signal.mint}</div>
                        </div>
                        <div>
                          <div className="font-semibold text-content">{signal.kolCount} KOLs</div>
                          <div className="mt-0.5 truncate text-[9px] text-content-muted">{signal.handles.slice(0, 4).map((handle) => `@${handle}`).join(" · ")}</div>
                        </div>
                        <div>
                          <div className="text-[9px] text-content-faint">24h directional</div>
                          <div className={`mt-0.5 font-mono font-semibold ${outcome && outcome.netDirectionalReturnPct > 0 ? "text-emerald-300" : outcome && outcome.netDirectionalReturnPct < 0 ? "text-danger" : "text-content-muted"}`}>
                            {outcome ? percent(outcome.netDirectionalReturnPct) : "—"}
                          </div>
                        </div>
                        <div className="text-left text-[10px] text-content-muted md:text-right">{since(signal.signalAt)}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-bg-border p-4 text-center text-xs text-content-muted">
                При выбранных параметрах исторические сигналы не сформировались.
              </div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function CoverageCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-elevated/30 p-3">
      <div className="text-[9px] font-semibold uppercase tracking-wider text-content-faint">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold text-content">{value}</div>
    </div>
  );
}
