"use client";
// data-tag: components.trade.dev_history_v3

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart2,
  Clock,
  ExternalLink,
  History,
  Loader2,
  Network,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";

interface ThresholdStat {
  thresholdUsd: number;
  successCount: number;
  observedCount: number;
  rate: number | null;
  coverage: number;
}

interface RollingStat {
  window: number | "lifetime";
  launches: number;
  observedCount: number;
  successCount: number;
  successRate: number | null;
  coverage: number;
}


interface OutcomeHorizonStat {
  horizon: "5m" | "15m" | "1h" | "6h" | "24h";
  eligibleLaunches: number;
  retentionEligibleLaunches: number;
  samples: number;
  retentionSamples: number;
  coverage: number;
  retentionCoverage: number;
  meanReturnPct: number | null;
  medianReturnPct: number | null;
  p25ReturnPct: number | null;
  p75ReturnPct: number | null;
  positiveReturnRate: number | null;
  recordedAthDrawdownSamples: number;
  medianRecordedAthDrawdownPct: number | null;
  staleAthConflictCount: number;
}

interface PostMigrationStat {
  horizon: "1h" | "6h" | "24h";
  eligibleMigrations: number;
  retentionEligibleMigrations: number;
  returnSamples: number;
  retentionReturnSamples: number;
  returnCoverage: number;
  retentionReturnCoverage: number;
  medianReturnPct: number | null;
  positiveReturnRate: number | null;
  survivalObserved: number;
  retentionSurvivalObserved: number;
  survivalCoverage: number;
  retentionSurvivalCoverage: number;
  aliveCount: number;
  explicitDeadCount: number;
  survivalConflictCount: number;
  survivalRate: number | null;
}

interface DevOutcomeResponse {
  schemaVersion: 2;
  retentionDays: number;
  launchAnchorObserved: number;
  launchAnchorCoverage: number;
  retentionEligibleLaunchAnchors: number;
  retentionLaunchAnchorCoverage: number;
  horizons: Record<"5m" | "15m" | "1h" | "6h" | "24h", OutcomeHorizonStat>;
  postMigration: {
    migrationTimestampObserved: number;
    migrationAnchorObserved: number;
    horizons: Record<"1h" | "6h" | "24h", PostMigrationStat>;
  };
  recent: Array<{
    mint: string;
    symbol: string | null;
    createdAt: number | null;
    returnsPct: Partial<Record<"5m" | "15m" | "1h" | "6h" | "24h", number | null>>;
    recordedAthDrawdownPct24h: number | null;
  }>;
  evidence: { temporalTokens: number; notes: string[] };
}

interface DevHistoryResponse {
  available: boolean;
  creator: string | null;
  mint: string | null;
  fetchedAt?: number;
  source?: "live-or-cache" | "local-cache";
  warning?: string | null;
  reason?: string;
  outcomes?: DevOutcomeResponse;
  forensics?: {
    available: boolean;
    analyzedAt: number | null;
    medianLifespanHours: number | null;
    averageLifespanHours: number | null;
    over24hSurvivalRate: number | null;
    lifespanObserved: number;
    lifespanCoverage: number;
  };
  analytics?: {
    schemaVersion: 2;
    previousLaunches: number;
    migrationCount: number;
    migrationRate: number | null;
    ath: {
      observedCount: number;
      coverage: number;
      medianUsd: number | null;
      averageUsd: number | null;
      p25Usd: number | null;
      p75Usd: number | null;
      maxUsd: number | null;
    };
    thresholds: {
      reached100k: ThresholdStat;
      reached300k: ThresholdStat;
      reached1m: ThresholdStat;
    };
    distribution: Array<{
      key: string;
      label: string;
      count: number;
      shareOfObserved: number | null;
    }>;
    rolling100k: {
      lifetime: RollingStat;
      last20: RollingStat;
      last5: RollingStat;
    };
    trend: {
      state: "improving" | "stable" | "declining" | "unknown";
      recentWindow: number;
      previousWindow: number;
      recentMedianAthUsd: number | null;
      previousMedianAthUsd: number | null;
      recent100kRate: number | null;
      previous100kRate: number | null;
    };
    cadence: {
      observedLaunches: number;
      coverage: number;
      medianIntervalSec: number | null;
      averageIntervalSec: number | null;
      minIntervalSec: number | null;
      launches30d: number | null;
      maxLaunchesPerDay: number | null;
      lastLaunchAt: number | null;
    };
    recentLaunches: Array<{
      mint: string;
      symbol: string | null;
      name: string | null;
      createdAt: number | null;
      athUsd: number | null;
      currentMarketCapUsd: number | null;
      isMigrated: boolean;
      reached300k: boolean;
    }>;
    recurringNetwork: {
      wallets: Array<{
        wallet: string;
        tokenCount: number;
        tradeCount: number;
        volumeSol: number | null;
        firstSeen: number | null;
        lastSeen: number | null;
      }>;
      coveredTokens: number;
      totalTokens: number;
      coverage: number;
    };
    evidence: {
      athObserved: number;
      launchTimeObserved: number;
      recurringNetworkCoveredTokens: number;
      notes: string[];
    };
  };
}

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function rate(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`;
}


function signedPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(Math.abs(value) >= 100 ? 0 : 1)}%`;
}

function returnClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "text-content-faint";
  if (value > 0) return "text-green-300";
  if (value < 0) return "text-red-300";
  return "text-content-muted";
}

function shortAddress(value: string): string {
  return value.length > 13 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value;
}

function duration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(sec < 600 ? 1 : 0)}m`;
  if (sec < 86_400) return `${(sec / 3600).toFixed(sec < 36_000 ? 1 : 0)}h`;
  return `${(sec / 86_400).toFixed(1)}d`;
}

function age(timestamp: number | null | undefined): string {
  if (timestamp == null) return "—";
  const sec = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (sec < 3600) return `${Math.max(1, Math.floor(sec / 60))}m`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86_400)}d`;
}

function StatCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-elevated/35 p-3">
      <div className="text-[9px] font-semibold uppercase tracking-[0.13em] text-content-faint">{label}</div>
      <div className="mt-1.5 text-lg font-semibold text-content">{value}</div>
      {note && <div className="mt-1 text-[10px] leading-4 text-content-faint">{note}</div>}
    </div>
  );
}

function ThresholdCard({ label, stat, total }: { label: string; stat: ThresholdStat; total: number }) {
  return (
    <StatCard
      label={label}
      value={rate(stat.rate)}
      note={stat.observedCount > 0
        ? `${stat.successCount}/${stat.observedCount} observed · coverage ${rate(stat.coverage)}`
        : `Нет подтверждённых ATH outcomes · 0/${total}`}
    />
  );
}

function RollingCard({ label, stat }: { label: string; stat: RollingStat }) {
  return (
    <div className="rounded-lg border border-bg-border bg-black/10 px-3 py-2">
      <div className="text-[9px] uppercase tracking-[0.12em] text-content-faint">{label}</div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <span className="text-base font-semibold text-content">{rate(stat.successRate)}</span>
        <span className="text-[9px] text-content-faint">{stat.successCount}/{stat.observedCount}</span>
      </div>
    </div>
  );
}

function TrendBadge({ state }: { state: "improving" | "stable" | "declining" | "unknown" }) {
  if (state === "improving") {
    return <span className="inline-flex items-center gap-1 rounded border border-green-500/25 bg-green-500/10 px-2 py-1 text-[10px] font-semibold text-green-300"><TrendingUp className="h-3 w-3" />IMPROVING</span>;
  }
  if (state === "declining") {
    return <span className="inline-flex items-center gap-1 rounded border border-red-500/25 bg-red-500/10 px-2 py-1 text-[10px] font-semibold text-red-300"><TrendingDown className="h-3 w-3" />DECLINING</span>;
  }
  if (state === "stable") {
    return <span className="rounded border border-bg-border bg-white/5 px-2 py-1 text-[10px] font-semibold text-content-muted">STABLE</span>;
  }
  return <span className="rounded border border-bg-border bg-white/5 px-2 py-1 text-[10px] font-semibold text-content-faint">UNKNOWN</span>;
}

function friendlyDevHistoryError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason || "");
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "DEV History API не вернул ответ. История остаётся неизвестной и не считается нулевой.";
  }
  if (/timeout|timed out|aborted/i.test(message)) {
    return "DEV History временно недоступна: live-источник отвечает слишком долго.";
  }
  return message || "DEV history временно недоступна.";
}

export default function DevHistoryV2({ mint }: { mint: string }) {
  const [data, setData] = useState<DevHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/trade/dev-history?mint=${encodeURIComponent(mint)}${refresh ? "&refresh=1" : ""}`, {
        cache: "no-store",
      });
      const json = await response.json().catch(() => null) as DevHistoryResponse | null;
      if (!response.ok) throw new Error(json?.reason || (json as { error?: string } | null)?.error || `HTTP ${response.status}`);
      setData(json);
    } catch (reason) {
      setError(friendlyDevHistoryError(reason));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [mint]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const analytics = data?.analytics;
  const maxBucket = useMemo(
    () => analytics ? Math.max(1, ...analytics.distribution.map((row) => row.count)) : 1,
    [analytics],
  );

  const outcomes = data?.outcomes;
  const recentOutcomeByMint = useMemo(
    () => new Map((outcomes?.recent || []).map((row) => [row.mint, row] as const)),
    [outcomes],
  );

  if (loading) {
    return (
      <section className="rounded-2xl border border-bg-border bg-bg-card/70 p-5" data-tag="trade.dev_history_v3.loading">
        <div className="flex items-center gap-2 text-sm text-content-muted"><Loader2 className="h-4 w-4 animate-spin text-primary" />Собираю историю прошлых запусков DEV…</div>
      </section>
    );
  }

  if (error || !data?.available || !analytics || !data.creator) {
    return (
      <section className="rounded-2xl border border-bg-border bg-bg-card/70 p-5" data-tag="trade.dev_history_v3.unavailable">
        <div className="flex items-center gap-2"><History className="h-4 w-4 text-content-faint" /><h2 className="text-sm font-semibold text-content">DEV History V3</h2></div>
        <p className="mt-2 text-xs text-content-faint">{error || data?.reason || "История предыдущих монет DEV пока недоступна."}</p>
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-2xl border border-bg-border bg-bg-card/70 p-4 sm:p-5" data-tag="trade.dev_history_v3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-primary/25 bg-primary/10"><History className="h-4 w-4 text-primary" /></div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-content">DEV History V3</h2>
              {data.source === "local-cache" && <span className="rounded border border-yellow-500/25 bg-yellow-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-yellow-300">LOCAL CACHE</span>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-content-faint">
              <span className="font-mono">{shortAddress(data.creator)}</span>
              <span>·</span>
              <span>{analytics.previousLaunches} previous launches</span>
              <span>·</span>
              <span>current mint excluded</span>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-lg border border-bg-border bg-bg-elevated/40 px-2.5 py-1.5 text-[10px] text-content-muted transition hover:text-content disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />Refresh history
        </button>
      </div>

      {data.warning && <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3 py-2 text-[10px] leading-4 text-yellow-200/80">{data.warning}</div>}

      {data.forensics?.available && (
        <div className="rounded-xl border border-bg-border bg-bg-elevated/25 p-4" data-tag="trade.dev_history_v3.forensics_lifespan">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[9px] uppercase tracking-[0.13em] text-content-faint">Historical lifespan evidence</div>
              <div className="mt-1 text-xs text-content-muted">Observed lifespan is shown only when DEV forensics has historical evidence; missing observations stay unknown.</div>
            </div>
            <span className="text-[9px] text-content-faint">coverage {rate(data.forensics.lifespanCoverage)} · N={data.forensics.lifespanObserved}</span>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <StatCard
              label="Median lifespan"
              value={data.forensics.medianLifespanHours == null ? "—" : duration(data.forensics.medianLifespanHours * 3600)}
              note={`observed N=${data.forensics.lifespanObserved}`}
            />
            <StatCard
              label="Average lifespan"
              value={data.forensics.averageLifespanHours == null ? "—" : duration(data.forensics.averageLifespanHours * 3600)}
              note={`coverage ${rate(data.forensics.lifespanCoverage)}`}
            />
            <StatCard
              label="Observed >24h"
              value={rate(data.forensics.over24hSurvivalRate)}
              note=">24h survival from observed historical lifespan evidence only"
            />
          </div>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Previous launches" value={String(analytics.previousLaunches)} note="Текущая монета не входит" />
        <StatCard label="Confirmed migrated" value={rate(analytics.migrationRate)} note={`${analytics.migrationCount}/${analytics.previousLaunches} · lower bound`} />
        <ThresholdCard label="Reached $100k" stat={analytics.thresholds.reached100k} total={analytics.previousLaunches} />
        <ThresholdCard label="Reached $300k" stat={analytics.thresholds.reached300k} total={analytics.previousLaunches} />
        <ThresholdCard label="Reached $1M" stat={analytics.thresholds.reached1m} total={analytics.previousLaunches} />
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-xl border border-bg-border bg-bg-elevated/25 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2"><BarChart2 className="h-4 w-4 text-primary" /><h3 className="text-xs font-semibold text-content">ATH performance distribution</h3></div>
            <span className="text-[9px] text-content-faint">exact ATH coverage {rate(analytics.ath.coverage)} · N={analytics.ath.observedCount}</span>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <StatCard label="Median ATH" value={money(analytics.ath.medianUsd)} />
            <StatCard label="Average ATH" value={money(analytics.ath.averageUsd)} />
            <StatCard label="P25 / P75" value={`${money(analytics.ath.p25Usd)} / ${money(analytics.ath.p75Usd)}`} />
            <StatCard label="Best ATH" value={money(analytics.ath.maxUsd)} />
          </div>
          <div className="mt-4 space-y-2">
            {analytics.distribution.map((row) => (
              <div key={row.key} className="grid grid-cols-[82px_1fr_36px] items-center gap-2 text-[10px]">
                <span className="text-content-faint">{row.label}</span>
                <div className="h-2 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(row.count > 0 ? 5 : 0, (row.count / maxBucket) * 100)}%` }} /></div>
                <span className="text-right font-mono text-content-muted">{row.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-bg-border bg-bg-elevated/25 p-4">
          <div className="flex items-center justify-between gap-3">
            <div><div className="text-[9px] uppercase tracking-[0.13em] text-content-faint">Creator performance trend</div><div className="mt-1 text-xs text-content-muted">$100k success · recent vs historical launches</div></div>
            <TrendBadge state={analytics.trend.state} />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <RollingCard label="Lifetime" stat={analytics.rolling100k.lifetime} />
            <RollingCard label="Last 20" stat={analytics.rolling100k.last20} />
            <RollingCard label="Last 5" stat={analytics.rolling100k.last5} />
          </div>
          <div className="mt-3 rounded-lg border border-bg-border bg-black/10 p-3 text-[10px] leading-5 text-content-faint">
            <div className="flex justify-between gap-3"><span>Recent median ATH</span><span className="font-mono text-content-muted">{money(analytics.trend.recentMedianAthUsd)}</span></div>
            <div className="flex justify-between gap-3"><span>Previous median ATH</span><span className="font-mono text-content-muted">{money(analytics.trend.previousMedianAthUsd)}</span></div>
            <div className="flex justify-between gap-3"><span>Recent $100k rate</span><span className="font-mono text-content-muted">{rate(analytics.trend.recent100kRate)}</span></div>
            <div className="flex justify-between gap-3"><span>Previous $100k rate</span><span className="font-mono text-content-muted">{rate(analytics.trend.previous100kRate)}</span></div>
          </div>
        </div>
      </div>


      {outcomes && (
        <div className="space-y-3 rounded-xl border border-bg-border bg-bg-elevated/25 p-4" data-tag="trade.dev_history_v3.outcomes">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <Activity className="mt-0.5 h-4 w-4 text-primary" />
              <div>
                <h3 className="text-xs font-semibold text-content">Observed launch outcome curve</h3>
                <p className="mt-1 text-[9px] leading-4 text-content-faint">Temporal sample, not a lifetime census. Returns require persisted price evidence close to launch and each horizon; missing/out-of-window observations stay unknown.</p>
              </div>
            </div>
            <div className="text-right text-[9px] leading-4 text-content-faint">
              <div>retained launch anchors {rate(outcomes.retentionLaunchAnchorCoverage)} · N={outcomes.retentionEligibleLaunchAnchors}</div>
              <div>local temporal window ≈ {outcomes.retentionDays}d · lifetime anchors {outcomes.launchAnchorObserved}/{analytics.previousLaunches}</div>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-bg-border bg-black/10">
            <table className="w-full min-w-[780px] text-left text-[10px]">
              <thead className="text-content-faint">
                <tr>
                  <th className="px-3 py-2 font-medium">Horizon</th>
                  <th className="px-3 py-2 font-medium">Median return</th>
                  <th className="px-3 py-2 font-medium">P25 / P75</th>
                  <th className="px-3 py-2 font-medium">Positive</th>
                  <th className="px-3 py-2 font-medium">Temporal coverage</th>
                  <th className="px-3 py-2 font-medium">Median vs recorded ATH</th>
                </tr>
              </thead>
              <tbody>
                {(["5m", "15m", "1h", "6h", "24h"] as const).map((horizon) => {
                  const row = outcomes.horizons[horizon];
                  return (
                    <tr key={horizon} className="border-t border-bg-border/70">
                      <td className="px-3 py-2 font-semibold text-content">+{horizon}</td>
                      <td className={`px-3 py-2 font-mono font-semibold ${returnClass(row.medianReturnPct)}`}>{signedPct(row.medianReturnPct)}</td>
                      <td className="px-3 py-2 font-mono text-content-muted">{signedPct(row.p25ReturnPct)} / {signedPct(row.p75ReturnPct)}</td>
                      <td className="px-3 py-2 text-content-muted">{rate(row.positiveReturnRate)}</td>
                      <td className="px-3 py-2 text-content-muted">
                        <div>{row.retentionSamples}/{row.retentionEligibleLaunches} retained · {rate(row.retentionCoverage)}</div>
                        <div className="text-[9px] text-content-faint">lifetime evidence {rate(row.coverage)} · eligible {row.eligibleLaunches}</div>
                      </td>
                      <td className="px-3 py-2 text-content-muted">
                        {row.medianRecordedAthDrawdownPct == null ? "—" : `-${row.medianRecordedAthDrawdownPct.toFixed(1)}%`}
                        {row.recordedAthDrawdownSamples > 0 && <span className="ml-1 text-content-faint">N={row.recordedAthDrawdownSamples}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {outcomes.postMigration.migrationTimestampObserved > 0 ? (
            <div className="rounded-lg border border-bg-border bg-black/10 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[10px] font-semibold text-content">Post-migration replay</div>
                  <div className="mt-0.5 text-[9px] text-content-faint">Only canonical/persisted migration timestamps are eligible; unknown migration time is not inferred.</div>
                </div>
                <span className="text-[9px] text-content-faint">migration timestamps {outcomes.postMigration.migrationTimestampObserved} · price anchors {outcomes.postMigration.migrationAnchorObserved}</span>
              </div>
              <div className="mt-2 grid gap-2 md:grid-cols-3">
                {(["1h", "6h", "24h"] as const).map((horizon) => {
                  const row = outcomes.postMigration.horizons[horizon];
                  return (
                    <div key={horizon} className="rounded-lg border border-bg-border bg-bg-elevated/25 p-3">
                      <div className="text-[9px] uppercase tracking-[0.12em] text-content-faint">Migration +{horizon}</div>
                      <div className={`mt-1 text-lg font-semibold ${returnClass(row.medianReturnPct)}`}>{signedPct(row.medianReturnPct)}</div>
                      <div className="mt-1 text-[9px] leading-4 text-content-faint">return N={row.retentionReturnSamples}/{row.retentionEligibleMigrations} retained · {rate(row.retentionReturnCoverage)}</div>
                      <div className="text-[9px] leading-4 text-content-faint">observed market survival {rate(row.survivalRate)} · retained N={row.retentionSurvivalObserved}/{row.retentionEligibleMigrations} · {rate(row.retentionSurvivalCoverage)}</div>
                      {row.survivalConflictCount > 0 && <div className="text-[9px] leading-4 text-amber-300/80">{row.survivalConflictCount} contradictory price/liquidity row(s) excluded</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-bg-border bg-black/10 px-3 py-2 text-[9px] leading-4 text-content-faint">Post-migration replay пока `—`: в сохранённой истории нет доказанного migration timestamp. Новые canonical migration timestamps теперь сохраняются в temporal snapshots и будут накапливаться автоматически.</div>
          )}
        </div>
      )}

      <div className="grid gap-3 xl:grid-cols-[0.78fr_1.22fr]">
        <div className="rounded-xl border border-bg-border bg-bg-elevated/25 p-4">
          <div className="flex items-center gap-2"><Clock className="h-4 w-4 text-primary" /><h3 className="text-xs font-semibold text-content">Launch cadence</h3></div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <StatCard label="Median interval" value={duration(analytics.cadence.medianIntervalSec)} />
            <StatCard label="Launches / 30d" value={analytics.cadence.launches30d == null ? "—" : String(analytics.cadence.launches30d)} />
            <StatCard
              label="Launch price anchors"
              value={outcomes ? String(outcomes.launchAnchorObserved) : "—"}
              note={outcomes ? `temporal coverage ${rate(outcomes.launchAnchorCoverage)}` : "temporal replay unavailable"}
            />
            <StatCard
              label="Temporal tokens"
              value={outcomes ? String(outcomes.evidence.temporalTokens) : "—"}
              note={outcomes ? `local retention ≈ ${outcomes.retentionDays}d` : "temporal replay unavailable"}
            />
            <StatCard label="Average interval" value={duration(analytics.cadence.averageIntervalSec)} />
            <StatCard label="Max / day" value={analytics.cadence.maxLaunchesPerDay == null ? "—" : String(analytics.cadence.maxLaunchesPerDay)} />
          </div>
          <div className="mt-2 text-[9px] text-content-faint">Timestamp coverage {rate(analytics.cadence.coverage)} · N={analytics.cadence.observedLaunches}</div>
        </div>

        <div className="overflow-hidden rounded-xl border border-bg-border bg-bg-elevated/25">
          <div className="flex items-center justify-between gap-3 border-b border-bg-border px-4 py-3">
            <h3 className="text-xs font-semibold text-content">Recent previous launches</h3>
            <span className="text-[9px] text-content-faint">ATH ≠ current MC</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[840px] text-left text-[10px]">
              <thead className="bg-black/10 text-content-faint"><tr><th className="px-3 py-2 font-medium">Token</th><th className="px-3 py-2 font-medium">Age</th><th className="px-3 py-2 font-medium">ATH</th><th className="px-3 py-2 font-medium">Current MC</th><th className="px-3 py-2 font-medium">+1h</th><th className="px-3 py-2 font-medium">+6h</th><th className="px-3 py-2 font-medium">+24h</th><th className="px-3 py-2 font-medium">Migration</th><th className="px-3 py-2 font-medium">Mint</th></tr></thead>
              <tbody>
                {analytics.recentLaunches.slice(0, 10).map((token) => {
                  const outcome = recentOutcomeByMint.get(token.mint);
                  return (
                    <tr key={token.mint} className="border-t border-bg-border/70">
                      <td className="px-3 py-2"><div className="font-semibold text-content">{token.symbol || token.name || "Unknown"}</div></td>
                      <td className="px-3 py-2 text-content-muted">{age(token.createdAt)}</td>
                      <td className="px-3 py-2 font-mono text-content">{money(token.athUsd)}</td>
                      <td className="px-3 py-2 font-mono text-content-muted">{money(token.currentMarketCapUsd)}</td>
                      <td className={`px-3 py-2 font-mono ${returnClass(outcome?.returnsPct?.["1h"])}`}>{signedPct(outcome?.returnsPct?.["1h"])}</td>
                      <td className={`px-3 py-2 font-mono ${returnClass(outcome?.returnsPct?.["6h"])}`}>{signedPct(outcome?.returnsPct?.["6h"])}</td>
                      <td className={`px-3 py-2 font-mono ${returnClass(outcome?.returnsPct?.["24h"])}`}>{signedPct(outcome?.returnsPct?.["24h"])}</td>
                      <td className="px-3 py-2"><span className={token.isMigrated ? "text-green-300" : "text-content-faint"}>{token.isMigrated ? "YES" : "NO / unknown"}</span></td>
                      <td className="px-3 py-2"><a href={`https://solscan.io/token/${token.mint}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-content-faint hover:text-primary">{shortAddress(token.mint)}<ExternalLink className="h-2.5 w-2.5" /></a></td>
                    </tr>
                  );
                })}
                {analytics.recentLaunches.length === 0 && <tr><td colSpan={9} className="px-3 py-5 text-center text-content-faint">Нет предыдущих запусков</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-bg-border bg-bg-elevated/25 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2"><Network className="h-4 w-4 text-primary" /><h3 className="text-xs font-semibold text-content">Recurring wallet network</h3></div>
          <div className="text-[9px] text-content-faint">trade-history coverage {rate(analytics.recurringNetwork.coverage)} · {analytics.recurringNetwork.coveredTokens}/{analytics.recurringNetwork.totalTokens} prior tokens</div>
        </div>
        {analytics.recurringNetwork.wallets.length > 0 ? (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {analytics.recurringNetwork.wallets.slice(0, 8).map((wallet) => (
              <div key={wallet.wallet} className="rounded-lg border border-bg-border bg-black/10 p-3">
                <div className="flex items-center justify-between gap-2"><span className="font-mono text-[10px] text-content">{shortAddress(wallet.wallet)}</span><Users className="h-3 w-3 text-content-faint" /></div>
                <div className="mt-2 text-lg font-semibold text-content">{wallet.tokenCount}<span className="ml-1 text-[9px] font-normal text-content-faint">launches</span></div>
                <div className="mt-1 text-[9px] text-content-faint">{wallet.tradeCount} trades{wallet.volumeSol != null ? ` · ${wallet.volumeSol.toFixed(1)} SOL observed` : ""}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-bg-border bg-black/10 px-3 py-3 text-[10px] text-content-faint">
            {analytics.recurringNetwork.coverage > 0
              ? "В доступной локальной trade-history повторяющиеся wallets между предыдущими токенами не найдены."
              : "Нет локальной trade-history по предыдущим токенам — recurring-wallet network остаётся неизвестной."}
          </div>
        )}
      </div>

      <details className="rounded-xl border border-bg-border bg-black/10">
        <summary className="cursor-pointer px-4 py-3 text-[10px] font-semibold text-content-muted">Evidence / coverage notes</summary>
        <div className="space-y-1 border-t border-bg-border px-4 py-3 text-[10px] leading-5 text-content-faint">
          {outcomes?.evidence.notes.map((note, index) => <div key={`outcome-${index}`}>• {note}</div>)}
          {analytics.evidence.notes.map((note, index) => <div key={index}>• {note}</div>)}
        </div>
      </details>
    </section>
  );
}
