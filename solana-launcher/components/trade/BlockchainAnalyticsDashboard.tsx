"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Boxes,
  Braces,
  ChevronRight,
  CircleAlert,
  Copy,
  DatabaseZap,
  GitBranch,
  Loader2,
  RefreshCw,
  ShieldCheck,
  TimerReset,
  Users,
  WalletCards,
  Waves,
} from "lucide-react";
import type { AiFact, BlockchainAiSnapshot } from "@/lib/trade/chain/ai-snapshot";

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type DashboardTab = "summary" | "v34" | "v35" | "evidence" | "snapshot";

type SnapshotResponse = {
  available?: boolean;
  mint?: string;
  error?: string;
  latencyMs?: number;
  cacheHit?: boolean;
  cacheAgeMs?: number;
  snapshot?: BlockchainAiSnapshot;
};

const DASHBOARD_TABS: Array<{ id: DashboardTab; label: string; icon: typeof Activity }> = [
  { id: "summary", label: "Сводка", icon: Activity },
  { id: "v34", label: "V3.4", icon: Waves },
  { id: "v35", label: "V3.5 / Replay", icon: TimerReset },
  { id: "evidence", label: "Evidence", icon: ShieldCheck },
  { id: "snapshot", label: "Snapshot", icon: Braces },
];

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function pct100(value: number | null | undefined, digits = 1): string {
  return finite(value) ? `${value.toFixed(digits)}%` : "—";
}

function sharePct(value: number | null | undefined, digits = 1): string {
  return finite(value) ? `${(value * 100).toFixed(digits)}%` : "—";
}

function signed(value: number | null | undefined, digits = 2): string {
  if (!finite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function compactNumber(value: number | null | undefined, digits = 2): string {
  if (!finite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(digits)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(digits)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(digits)}K`;
  return value.toFixed(abs >= 100 ? 0 : digits);
}

function usd(value: number | null | undefined): string {
  return finite(value) ? `$${compactNumber(value)}` : "—";
}

function shortAddress(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 16 ? `${value.slice(0, 7)}…${value.slice(-6)}` : value;
}

function age(ms: number | null | undefined): string {
  if (!finite(ms)) return "—";
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(ms < 36_000_000 ? 1 : 0)}h`;
}

function timestamp(value: number | null | undefined): string {
  if (!finite(value) || value <= 0) return "—";
  const ms = value > 10_000_000_000 ? value : value * 1_000;
  return new Date(ms).toLocaleString();
}

function factValue(fact: AiFact): string {
  const value = fact.value;
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "YES" : "NO";
  if (typeof value === "string") return value;
  if (!finite(value)) return "—";
  if (fact.valueScale === "share01") return sharePct(value);
  if (fact.valueScale === "signed11") return signed(value, 3);
  if (fact.valueScale === "percent100") return pct100(value);
  if (fact.valueScale === "score100") return value.toFixed(1);
  if (fact.unit === "USD") return usd(value);
  if (fact.unit === "%") return pct100(value);
  if (fact.unit === "SOL") return `${signed(value, 2)} SOL`;
  return compactNumber(value);
}

function metricTone(value: number | null | undefined, direction: "positive" | "risk" = "positive") {
  if (!finite(value)) return "text-content";
  if (direction === "risk") {
    if (value >= 70) return "text-danger";
    if (value >= 45) return "text-warning";
    return "text-content";
  }
  if (value >= 70) return "text-green-300";
  if (value < 35) return "text-warning";
  return "text-content";
}

function scoreDirection(name: string): "positive" | "risk" {
  return name === "coordination" || name === "distributionRisk" ? "risk" : "positive";
}

function friendlyBlockchainDashboardError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason || "");
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "On-chain API не вернул ответ. Повтори запрос; unknown evidence не трактуется как zero или safe.";
  }
  if (/timeout|timed out|aborted/i.test(message)) {
    return "On-chain snapshot временно недоступен: один из источников отвечает слишком долго.";
  }
  return message || "Blockchain analytics временно недоступна.";
}

export default function BlockchainAnalyticsDashboard({ mint }: { mint: string }) {
  const [data, setData] = useState<SnapshotResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DashboardTab>("summary");
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async (refresh = false) => {
    if (!MINT_RE.test(mint)) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/trade/blockchain-ai", {
        method: "POST",
        cache: "no-store",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mint, refresh, detail: "full" }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as SnapshotResponse;
      if (seq !== seqRef.current) return;
      if (!response.ok || payload.available === false || !payload.snapshot) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      if (payload.mint && payload.mint !== mint) throw new Error("stale blockchain snapshot ignored");
      setData(payload);
    } catch (caught) {
      if (controller.signal.aborted || seq !== seqRef.current) return;
      setError(friendlyBlockchainDashboardError(caught));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [mint]);

  useEffect(() => {
    abortRef.current?.abort();
    seqRef.current += 1;
    setData(null);
    setError(null);
    setTab("summary");
    if (MINT_RE.test(mint)) void load(false);
    return () => abortRef.current?.abort();
  }, [load, mint]);

  const snapshot = data?.snapshot;
  const rawJson = useMemo(() => snapshot ? JSON.stringify(snapshot, null, 2) : "", [snapshot]);

  const copySnapshot = useCallback(async () => {
    if (!rawJson) return;
    try {
      await navigator.clipboard.writeText(rawJson);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }, [rawJson]);

  return (
    <section className="overflow-hidden rounded-2xl border border-bg-border bg-bg-card/65" data-tag="trade.blockchain.analytics.v11">
      <div className="border-b border-bg-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10">
              <DatabaseZap className="h-4 w-4 text-primary" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-content">Blockchain Analytics · полный on-chain слой</h2>
                <span className="rounded border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold text-primary">V1.1</span>
              </div>
              <p className="mt-1 max-w-4xl text-[10px] leading-4 text-content-faint">
                V1 + V3.4 evidence hardening + V3.5 temporal replay. Unknown не превращается в zero/safe; funding и coordination не считаются proof of ownership.
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => void load(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-bg-border bg-bg-elevated px-3 py-2 text-[10px] font-semibold text-content-muted transition hover:border-primary/20 hover:text-content disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Обновляю on-chain…" : "Обновить on-chain"}
          </button>
        </div>

        <div className="mt-4 flex gap-1 overflow-x-auto rounded-xl border border-bg-border bg-black/10 p-1">
          {DASHBOARD_TABS.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                disabled={!snapshot}
                onClick={() => setTab(item.id)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-[10px] font-semibold transition ${active ? "bg-primary/15 text-primary" : "text-content-faint hover:bg-white/5 hover:text-content-muted"} disabled:opacity-40`}
              >
                <Icon className="h-3.5 w-3.5" />
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="p-4">
        {error ? (
          <div className="flex items-start gap-2 rounded-xl border border-danger/25 bg-danger/5 p-3 text-xs text-danger">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : !snapshot ? (
          <div className="flex min-h-28 items-center justify-center gap-2 text-xs text-content-faint">
            {loading && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
            {loading ? "Собираю полный deterministic blockchain snapshot…" : "Blockchain snapshot пока недоступен."}
          </div>
        ) : (
          <>
            {tab === "summary" && <SummaryView snapshot={snapshot} latencyMs={data?.latencyMs} />}
            {tab === "v34" && <V34View snapshot={snapshot} />}
            {tab === "v35" && <V35View snapshot={snapshot} />}
            {tab === "evidence" && <EvidenceView snapshot={snapshot} />}
            {tab === "snapshot" && <SnapshotView snapshot={snapshot} rawJson={rawJson} copied={copied} onCopy={copySnapshot} />}
          </>
        )}
      </div>
    </section>
  );
}

function SummaryView({ snapshot, latencyMs }: { snapshot: BlockchainAiSnapshot; latencyMs?: number }) {
  const facts = snapshot.facts.filter((row) => !row.key.startsWith("dev.")).slice(0, 36);
  const scoreEntries = Object.entries(snapshot.headline.scores);
  return (
    <div className="space-y-4">
      {(snapshot.dataQuality.chainTruncated || snapshot.unknowns.length > 0 || snapshot.warnings.length > 0) && (
        <div className="rounded-xl border border-warning/25 bg-warning/5 p-3 text-[10px] leading-5 text-warning">
          <strong>Evidence status:</strong> {snapshot.dataQuality.chainTruncated ? "holder/trade evidence truncated · " : ""}
          unknowns {snapshot.dataQuality.listStats.unknownsTotal} · warnings {snapshot.dataQuality.listStats.warningsTotal}. Partial evidence снижает уверенность и не трактуется как safe.
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        <MetricCard label="Lifecycle" value={snapshot.headline.lifecycle.stage || "—"} note={`confidence ${sharePct(snapshot.headline.lifecycle.confidence)}`} />
        <MetricCard label="Evidence completeness" value={pct100(snapshot.headline.evidenceCompletenessPct, 0)} note="legacy category availability" />
        <MetricCard label="Safety fails" value={String(snapshot.headline.safetyFails)} note={`warn ${snapshot.headline.safetyWarnings} · unknown ${snapshot.headline.safetyUnknown}`} />
        <MetricCard label="Contradictions" value={String(snapshot.headline.contradictions)} />
        <MetricCard label="Chain source" value={snapshot.cache.chainSource} note={`age ${age(snapshot.cache.chainAgeMs)}`} />
        <MetricCard label="Snapshot latency" value={finite(latencyMs) ? `${latencyMs} ms` : "—"} note={`as-of ${timestamp(snapshot.asOf)}`} />
      </div>

      <div>
        <SectionHeader icon={<Activity />} title="Composite scores" subtitle="Score 0–100; confidence — качество evidence, а не вероятность будущей доходности." />
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {scoreEntries.map(([name, row]) => (
            <MetricCard
              key={name}
              label={humanize(name)}
              value={finite(row.value) ? row.value.toFixed(1) : "—"}
              note={`confidence ${sharePct(row.confidence)}`}
              valueClassName={metricTone(row.value, scoreDirection(name))}
            />
          ))}
        </div>
      </div>

      <div>
        <SectionHeader icon={<DatabaseZap />} title="Machine-readable facts" subtitle="Те же scalar evidence keys, которые используются Claim Contract validator." />
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {facts.map((fact) => (
            <div key={fact.key} className="rounded-xl border border-bg-border bg-bg-elevated/30 p-3">
              <div className="break-all font-mono text-[9px] text-content-faint">{fact.key}</div>
              <div className="mt-1.5 text-sm font-semibold text-content">{factValue(fact)}</div>
              <div className="mt-1 flex flex-wrap gap-x-2 text-[9px] text-content-faint">
                {finite(fact.coverage) && <span>coverage {sharePct(fact.coverage)}</span>}
                {finite(fact.confidence) && <span>confidence {sharePct(fact.confidence)}</span>}
                {fact.note && <span className="basis-full pt-1 leading-4">{fact.note}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function V34View({ snapshot }: { snapshot: BlockchainAiSnapshot }) {
  const v34 = snapshot.analysis.qualityV34;
  if (!v34) return <Unavailable text="V3.4 analytics unavailable for this snapshot." />;
  const flow = v34.orderFlow;
  const concentration = v34.concentrationDynamics;
  const bundles = v34.bundleAnalyticsV2;
  const funding = v34.fundingTree;
  const wash = v34.washTradingV2;
  const scoreEntries = Object.entries(v34.compositeScores);

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        <MetricCard label="Lifecycle" value={v34.lifecycle.stage} note={`confidence ${sharePct(v34.lifecycle.confidence)}`} />
        <MetricCard label="Top10 now" value={sharePct(concentration.top10ShareNow)} note={concentration.concentrationTrend} />
        <MetricCard label="Top10 velocity 1h" value={finite(concentration.velocity1h) ? `${signed(concentration.velocity1h * 100)} pp` : "—"} note={`baseline ${finite(concentration.baseline1hAgeMinutes) ? `${concentration.baseline1hAgeMinutes.toFixed(0)}m` : "—"}`} />
        <MetricCard label="Gini" value={finite(concentration.gini) ? concentration.gini.toFixed(3) : "—"} note={`coverage ${concentration.giniCoverageComplete === true ? "complete" : concentration.giniCoverageComplete === false ? "partial" : "unknown"}`} />
        <MetricCard label="Bundle supply" value={pct100(bundles.currentSupplyPct)} note={`verified atomic ${bundles.atomicBundleVerifiedCount ?? "—"}`} />
        <MetricCard label="Wash wallet share" value={pct100(wash.walletSharePct)} note={`circular ${wash.circularPatterns ?? "—"}`} />
      </div>

      {v34.lifecycle.rulesTriggered.length > 0 && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
          <div className="text-[9px] font-semibold uppercase tracking-wider text-primary">Lifecycle rules triggered</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {v34.lifecycle.rulesTriggered.map((rule) => <span key={rule} className="rounded-md border border-primary/15 bg-black/10 px-2 py-1 text-[10px] text-content-muted">{rule}</span>)}
          </div>
        </div>
      )}

      <div>
        <SectionHeader icon={<Waves />} title="Order Flow Imbalance" subtitle="OFI считается только в сопоставимой quote-единице; mixed USD/SOL не смешивается." />
        <div className="mt-2 grid gap-2 md:grid-cols-3">
          {(["ofi5m", "ofi15m", "ofi1h"] as const).map((key) => {
            const row = flow[key];
            return (
              <div key={key} className="rounded-xl border border-bg-border bg-bg-elevated/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10px] font-semibold uppercase text-content-muted">{key.replace("ofi", "OFI ")}</div>
                  <div className="font-mono text-sm font-semibold text-content">{signed(row.value, 3)}</div>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-[9px] text-content-faint">
                  <span>coverage<br /><b className="text-content-muted">{sharePct(row.coverage)}</b></span>
                  <span>buy<br /><b className="text-content-muted">{compactNumber(row.buyVolume)}</b></span>
                  <span>sell<br /><b className="text-content-muted">{compactNumber(row.sellVolume)}</b></span>
                </div>
                <div className="mt-2 font-mono text-[9px] text-content-faint">unit {row.unit || "—"}{row.quoteMint ? ` · ${shortAddress(row.quoteMint)}` : ""}</div>
              </div>
            );
          })}
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <MetricCard label="Buy pressure 1h" value={sharePct(flow.buyPressure1h)} />
          <MetricCard label="Whale net 1h" value={finite(flow.whaleNetFlow1h) ? `${signed(flow.whaleNetFlow1h)} SOL` : "—"} />
          <MetricCard label="Retail net 1h" value={finite(flow.retailNetFlow1h) ? `${signed(flow.retailNetFlow1h)} SOL` : "—"} note={`SOL coverage ${sharePct(flow.solCoverage1h)}`} />
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        <InfoBlock title="Bundles / coordination" icon={<Boxes />} rows={[
          ["available", yesNo(bundles.available)], ["groups", display(bundles.bundleCount)], ["wallets", display(bundles.walletCount)],
          ["current supply", pct100(bundles.currentSupplyPct)], ["bundle PnL", finite(bundles.bundlePnlPct) ? sharePct(bundles.bundlePnlPct) : "—"],
          ["exit ratio", sharePct(bundles.exitRatio)], ["remaining inventory", sharePct(bundles.remainingSupplyRatio)],
          ["creator overlap", display(bundles.bundleCreatorOverlap)], ["verified atomic", display(bundles.atomicBundleVerifiedCount)],
        ]} footer="Jito tip alone is not a verified atomic bundle." />
        <InfoBlock title="Funding tree" icon={<GitBranch />} rows={[
          ["available", yesNo(funding.available)], ["verified edges", display(funding.verifiedEdges)], ["partial edges", display(funding.partialEdges)],
          ["low-conf edges", display(funding.lowConfidenceEdges)], ["coverage", sharePct(funding.coverage)], ["roots", display(funding.rootCount)],
          ["leaves", display(funding.leafCount)], ["max depth", display(funding.maxDepth)], ["cycle", nullableYesNo(funding.cycleDetected)],
        ]} footer="Funding relation is association evidence, not proof of common ownership." />
        <InfoBlock title="Wash Trading V2" icon={<RefreshCw />} rows={[
          ["available", yesNo(wash.available)], ["wallets", display(wash.walletCount)], ["wallet share", pct100(wash.walletSharePct)],
          ["circular patterns", display(wash.circularPatterns)], ["suspicious pairs", display(wash.suspiciousPairs)], ["matched events", display(wash.matchedPairEvents)],
          ["Benford", display(wash.benfordScore, 3)], ["trade-size entropy", display(wash.tradeSizeEntropy, 3)], ["vol/price mismatch", nullableYesNo(wash.volumePriceMismatch)],
        ]} footer="Benford is weak supporting evidence, not a standalone wash verdict." />
      </div>

      <div>
        <SectionHeader icon={<Activity />} title="V3.4 composite scores" subtitle={`Global confidence ${sharePct(v34.confidence.value)} · penalties: ${v34.confidence.penalties.join(", ") || "none"}`} />
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {scoreEntries.map(([name, row]) => (
            <div key={name} className="rounded-xl border border-bg-border bg-bg-elevated/30 p-3">
              <div className="text-[9px] uppercase tracking-wide text-content-faint">{humanize(name.replace(/Score$/, ""))}</div>
              <div className="mt-1 flex items-end justify-between gap-2">
                <div className="text-lg font-semibold text-content">{finite(row.value) ? row.value.toFixed(1) : "—"}</div>
                <div className="text-[9px] text-content-faint">conf {sharePct(row.confidence.value)}</div>
              </div>
              {row.reasons.length > 0 && <div className="mt-2 text-[9px] leading-4 text-content-faint">{row.reasons.slice(0, 3).join(" · ")}</div>}
            </div>
          ))}
        </div>
      </div>

      <div>
        <SectionHeader icon={<WalletCards />} title="Wallet performance" subtitle="Top holder wallets; PnL remains unknown where inventory provenance is incomplete." />
        <div className="mt-2 overflow-x-auto rounded-xl border border-bg-border">
          <table className="min-w-[900px] w-full text-left text-[10px]">
            <thead className="bg-bg-elevated/60 text-content-faint"><tr>{["Wallet", "Trades", "Win rate", "Realized PnL", "Unrealized PnL", "Realized ratio", "Hold slots", "Smart money"].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-bg-border">
              {v34.walletPerformance.slice(0, 20).map((row) => (
                <tr key={row.wallet} className="text-content-muted">
                  <td className="px-3 py-2 font-mono">{shortAddress(row.wallet)}</td><td className="px-3 py-2">{row.tradeCount}</td><td className="px-3 py-2">{sharePct(row.winRate)}</td>
                  <td className="px-3 py-2">{finite(row.realizedPnlSol) ? `${signed(row.realizedPnlSol)} SOL` : "—"}</td><td className="px-3 py-2">{finite(row.unrealizedPnlSol) ? `${signed(row.unrealizedPnlSol)} SOL` : "—"}</td>
                  <td className="px-3 py-2">{sharePct(row.realizedRatio)}</td><td className="px-3 py-2">{display(row.medianHoldSlots, 0)}</td><td className="px-3 py-2">{nullableYesNo(row.isSmartMoney)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {v34.contradictions.length > 0 && (
        <div>
          <SectionHeader icon={<CircleAlert />} title="Contradictions" subtitle="Детерминированные расхождения между сигналами, которые нельзя игнорировать в AI-выводе." />
          <div className="mt-2 space-y-2">
            {v34.contradictions.map((row) => (
              <div key={`${row.type}-${row.description}`} className="rounded-xl border border-warning/20 bg-warning/5 p-3">
                <div className="flex flex-wrap items-center gap-2"><span className="text-[10px] font-semibold text-warning">{row.type}</span><span className="text-[9px] text-content-faint">severity {sharePct(row.severity)}</span></div>
                <div className="mt-1 text-xs leading-5 text-content-muted">{row.description}</div>
                <div className="mt-1 text-[9px] text-content-faint">{row.evidence.join(" · ")}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function V35View({ snapshot }: { snapshot: BlockchainAiSnapshot }) {
  const v35 = snapshot.analysis.qualityV35;
  if (!v35) return <Unavailable text="V3.5 temporal analytics unavailable for this snapshot." />;
  const current = v35.snapshot;
  const cohort = v35.holderCohortMigration.current;
  const replayEntries = Object.entries(v35.outcomeReplay.horizons) as Array<[string, (typeof v35.outcomeReplay.horizons)[keyof typeof v35.outcomeReplay.horizons]]>;

  return (
    <div className="space-y-4">
      <div>
        <SectionHeader icon={<TimerReset />} title="Current temporal snapshot" subtitle="As-of snapshot; future observations are excluded from the current anchor." />
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <MetricCard label="Observed" value={timestamp(current.observedAt)} />
          <MetricCard label="Price" value={finite(current.priceUsd) ? `$${current.priceUsd.toPrecision(5)}` : "—"} />
          <MetricCard label="Liquidity" value={usd(current.liquidityUsd)} />
          <MetricCard label="Market cap" value={usd(current.marketCapUsd)} />
          <MetricCard label="Lifecycle" value={current.lifecycleStage || "—"} />
          <MetricCard label="Migration at" value={timestamp(current.migrationAt)} />
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {Object.entries(current.signals).map(([key, value]) => <MetricCard key={key} label={humanize(key)} value={display(value, 3)} />)}
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <InfoBlock title="Liquidity-adjusted flow · 15m" icon={<Waves />} rows={liquidityRows(v35.liquidityAdjustedFlow.m15)} />
        <InfoBlock title="Liquidity-adjusted flow · 1h" icon={<Waves />} rows={liquidityRows(v35.liquidityAdjustedFlow.h1)} />
      </div>

      <div>
        <SectionHeader icon={<Users />} title="Holder cohort migration" subtitle="Cohorts are based on wallet first-seen age, not token-position age." />
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {Object.entries(cohort.cohorts).map(([key, row]) => (
            <MetricCard key={key} label={humanize(key)} value={pct100(row.supplyPct)} note={`${row.holderCount} holders`} />
          ))}
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-4">
          <MetricCard label="Sampled supply" value={pct100(cohort.sampledSupplyPct)} />
          <MetricCard label="Unobserved supply" value={pct100(cohort.unobservedSupplyPct)} />
          <MetricCard label="Age coverage" value={pct100(cohort.ageCoverageSupplyPct)} />
          <MetricCard label="Holder set" value={cohort.holderSetComplete ? "complete" : "partial"} />
        </div>
      </div>

      <div>
        <SectionHeader icon={<WalletCards />} title="Wallet temporal behavior" subtitle="Multi-window 5m / 15m / 1h / 6h with coverage-aware flows." />
        <div className="mt-2 overflow-x-auto rounded-xl border border-bg-border">
          <table className="min-w-[1000px] w-full text-left text-[10px]">
            <thead className="bg-bg-elevated/60 text-content-faint"><tr>{["Wallet", "Active windows", "15m net", "15m cov", "1h net", "1h cov", "Acceleration", "Buy persistence", "Sell persistence"].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-bg-border">
              {v35.walletBehavior.slice(0, 20).map((row) => (
                <tr key={row.wallet} className="text-content-muted">
                  <td className="px-3 py-2 font-mono">{shortAddress(row.wallet)}</td><td className="px-3 py-2">{row.activeWindowCount}</td>
                  <td className="px-3 py-2">{display(row.windows["15m"].netFlow, 2)}</td><td className="px-3 py-2">{sharePct(row.windows["15m"].coverage)}</td>
                  <td className="px-3 py-2">{display(row.windows["1h"].netFlow, 2)}</td><td className="px-3 py-2">{sharePct(row.windows["1h"].coverage)}</td>
                  <td className="px-3 py-2">{display(row.flowAcceleration15mVs1h, 3)}</td><td className="px-3 py-2">{sharePct(row.buyPersistence)}</td><td className="px-3 py-2">{sharePct(row.sellPersistence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <SectionHeader icon={<WalletCards />} title="FIFO cost-basis ledgers" subtitle="Authoritative PnL stays unknown until upstream proves full inventory provenance; unmatched inventory is shown explicitly." />
        <div className="mt-2 overflow-x-auto rounded-xl border border-bg-border">
          <table className="min-w-[1120px] w-full text-left text-[10px]">
            <thead className="bg-bg-elevated/60 text-content-faint"><tr>{["Wallet", "Trades", "Unit", "Realized PnL", "Unrealized PnL", "Total PnL", "Open tokens", "Unmatched sells", "History", "Ordering"].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-bg-border">
              {v35.costBasisLedgers.slice(0, 20).map((row) => (
                <tr key={row.wallet} className="text-content-muted">
                  <td className="px-3 py-2 font-mono">{shortAddress(row.wallet)}</td><td className="px-3 py-2">{row.tradeCount}</td><td className="px-3 py-2">{row.unit || "—"}</td>
                  <td className="px-3 py-2">{display(row.realizedPnl, 4)}</td><td className="px-3 py-2">{display(row.unrealizedPnl, 4)}</td><td className="px-3 py-2">{display(row.totalPnl, 4)}</td>
                  <td className="px-3 py-2">{display(row.openTokens, 2)}</td><td className="px-3 py-2">{display(row.unmatchedSellTokens, 2)}</td>
                  <td className="px-3 py-2">{row.historyComplete ? "complete" : "partial"}</td><td className="px-3 py-2">{row.orderingComplete ? "complete" : "ambiguous"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <SectionHeader icon={<GitBranch />} title="Persistent wallet clusters" subtitle="Coordination / funding / coactivity groups; coordination is not proof of insider control." />
        <div className="mt-2 grid gap-2 lg:grid-cols-2">
          {v35.walletClusters.slice(0, 16).map((row) => (
            <div key={row.clusterId} className="rounded-xl border border-bg-border bg-bg-elevated/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-[10px] font-semibold text-content">{row.clusterId}</span><span className="text-[9px] text-content-faint">persistence {sharePct(row.persistence01)}</span></div>
              <div className="mt-1 text-[9px] text-content-faint">{row.wallets.length} wallets · {row.sources.join(" · ")} · observations {row.observationCount}</div>
              <div className="mt-2 flex flex-wrap gap-1">{row.wallets.slice(0, 8).map((wallet) => <span key={wallet} className="rounded border border-bg-border px-1.5 py-0.5 font-mono text-[9px] text-content-muted">{shortAddress(wallet)}</span>)}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <SectionHeader icon={<TimerReset />} title="Outcome replay / backtest" subtitle="Non-overlapping forward windows. Correlation is association, not causality or a price prediction." />
        <div className="mt-2 grid gap-3 xl:grid-cols-2">
          {replayEntries.map(([horizon, row]) => {
            const demand = row.stats.demandMomentum;
            const distribution = row.stats.distributionRisk;
            const coordination = row.stats.coordination;
            return (
              <div key={horizon} className="rounded-xl border border-bg-border bg-bg-elevated/30 p-3">
                <div className="flex items-center justify-between gap-3"><div className="text-sm font-semibold text-content">+{horizon}</div><div className="text-[9px] text-content-faint">N {row.observations} · raw {row.rawObservations}</div></div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <ReplayStat label="Demand" row={demand} />
                  <ReplayStat label="Distribution" row={distribution} />
                  <ReplayStat label="Coordination" row={coordination} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EvidenceView({ snapshot }: { snapshot: BlockchainAiSnapshot }) {
  const evidenceEntries = Object.entries(snapshot.dataQuality.evidence);
  const checks = snapshot.analysis.full.checks;
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Chain truncated" value={snapshot.dataQuality.chainTruncated ? "YES" : "NO"} />
        <MetricCard label="DEV history" value={snapshot.dataQuality.devHistoryAvailable ? "available" : "unavailable"} note={snapshot.dataQuality.devHistoryWarning || undefined} />
        <MetricCard label="Source skew" value={age(snapshot.dataQuality.sourceTimes.sourceSkewMs)} />
        <MetricCard label="Generated" value={timestamp(snapshot.generatedAt)} note={`chain as-of ${timestamp(snapshot.dataQuality.sourceTimes.chainAsOf)}`} />
      </div>

      <div className="rounded-xl border border-bg-border bg-bg-elevated/25 p-3 text-[10px] leading-5 text-content-faint">
        {snapshot.dataQuality.evidenceCompletenessSemantics}
      </div>

      <div>
        <SectionHeader icon={<ShieldCheck />} title="Per-source evidence quality" subtitle="Availability, completeness, coverage and recency are independent; unknown stays unknown." />
        <div className="mt-2 overflow-x-auto rounded-xl border border-bg-border">
          <table className="min-w-[900px] w-full text-left text-[10px]">
            <thead className="bg-bg-elevated/60 text-content-faint"><tr>{["Evidence", "Available", "Complete", "Coverage", "Source", "Age", "Future skew", "Note"].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-bg-border">
              {evidenceEntries.map(([key, row]) => (
                <tr key={key} className="text-content-muted">
                  <td className="px-3 py-2 font-mono text-content">{key}</td><td className="px-3 py-2">{yesNo(row.available)}</td><td className="px-3 py-2">{yesNo(row.complete)}</td>
                  <td className="px-3 py-2">{pct100(row.coveragePct)}</td><td className="px-3 py-2 font-mono text-[9px]">{row.source}</td><td className="px-3 py-2">{age(row.ageMs)}</td>
                  <td className="px-3 py-2">{row.futureByMs && row.futureByMs > 0 ? age(row.futureByMs) : "—"}</td><td className="max-w-sm px-3 py-2 text-[9px] text-content-faint">{row.note || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <SectionHeader icon={<ShieldCheck />} title="Contract / safety checks" subtitle="Each row keeps provenance and fetchedAt instead of collapsing unavailable data into pass/fail." />
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {checks.map((row) => (
            <div key={row.id} className="rounded-xl border border-bg-border bg-bg-elevated/30 p-3">
              <div className="flex items-center justify-between gap-2"><span className="font-mono text-[10px] text-content">{row.id}</span><StatusBadge status={row.status} /></div>
              <div className="mt-2 text-[9px] leading-4 text-content-faint">{row.note || "no note"}</div>
              <div className="mt-2 break-all font-mono text-[9px] text-content-faint">{row.source} · {timestamp(row.fetchedAt)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <MessageList title={`Warnings (${snapshot.warnings.length})`} items={snapshot.warnings} tone="warning" />
        <MessageList title={`Unknowns (${snapshot.unknowns.length})`} items={snapshot.unknowns} tone="neutral" />
      </div>
    </div>
  );
}

function SnapshotView({ snapshot, rawJson, copied, onCopy }: { snapshot: BlockchainAiSnapshot; rawJson: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Schema" value={snapshot.schemaVersion} />
        <MetricCard label="Facts" value={String(snapshot.facts.length)} />
        <MetricCard label="Sections" value={String(Object.keys(snapshot.sections).length)} />
        <MetricCard label="Claim contract" value={snapshot.reportContract.claimContract.version} note={`max ${snapshot.reportContract.claimContract.maxClaims} claims`} />
      </div>

      <div>
        <SectionHeader icon={<Braces />} title="Structured sections" subtitle="Полный drill-down того, что получает AI; строки внутри snapshot считаются untrusted observed data, а не инструкциями." />
        <div className="mt-2 space-y-2">
          {Object.entries(snapshot.sections).map(([key, value]) => (
            <details key={key} className="rounded-xl border border-bg-border bg-bg-elevated/25">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-[10px] font-semibold text-content-muted">
                <span className="flex items-center gap-2"><ChevronRight className="h-3.5 w-3.5" />{humanize(key)}</span>
                <span className="font-mono text-[9px] text-content-faint">section.{key}</span>
              </summary>
              <pre className="max-h-[440px] overflow-auto border-t border-bg-border p-3 text-[9px] leading-4 text-content-faint">{JSON.stringify(value, null, 2)}</pre>
            </details>
          ))}
        </div>
      </div>

      <details className="rounded-xl border border-bg-border bg-bg-elevated/25">
        <summary className="cursor-pointer px-3 py-2.5 text-[10px] font-semibold text-content-muted">Claim Contract rules ({snapshot.reportContract.claimContract.evidenceKeyRules.length})</summary>
        <div className="space-y-1 border-t border-bg-border p-3 text-[10px] leading-5 text-content-faint">
          {snapshot.reportContract.claimContract.evidenceKeyRules.map((row) => <div key={row}>• {row}</div>)}
        </div>
      </details>

      <details className="rounded-xl border border-bg-border bg-black/20">
        <summary className="cursor-pointer px-3 py-2.5 text-[10px] font-semibold text-content-muted">Full raw blockchain-ai-v1.1 JSON</summary>
        <div className="border-t border-bg-border p-3">
          <div className="mb-2 flex justify-end">
            <button type="button" onClick={onCopy} className="inline-flex items-center gap-1.5 rounded-lg border border-bg-border bg-bg-elevated px-2.5 py-1.5 text-[9px] font-semibold text-content-muted hover:text-content"><Copy className="h-3 w-3" />{copied ? "Скопировано" : "Копировать JSON"}</button>
          </div>
          <pre className="max-h-[680px] overflow-auto rounded-lg bg-black/20 p-3 text-[9px] leading-4 text-content-faint">{rawJson}</pre>
        </div>
      </details>
    </div>
  );
}

function liquidityRows(row: { available: boolean; coverage: number; netFlowUsd: number | null; grossFlowUsd: number | null; netFlowToLiquidity: number | null; grossTurnoverToLiquidity: number | null; signedPressure01: number | null }) {
  return [
    ["available", yesNo(row.available)], ["coverage", sharePct(row.coverage)], ["net flow", usd(row.netFlowUsd)], ["gross flow", usd(row.grossFlowUsd)],
    ["net/liquidity", sharePct(row.netFlowToLiquidity)], ["turnover/liquidity", sharePct(row.grossTurnoverToLiquidity)], ["signed pressure", signed(row.signedPressure01, 3)],
  ] as Array<[string, string]>;
}

function ReplayStat({ label, row }: { label: string; row: { samples: number; medianPriceReturnPct: number | null; positiveReturnRate: number | null; spearmanSignalPriceReturn: number | null } }) {
  return (
    <div className="rounded-lg border border-bg-border bg-black/10 p-2">
      <div className="text-[9px] font-semibold text-content-muted">{label}</div>
      <div className="mt-1 text-[9px] leading-4 text-content-faint">N {row.samples}<br />median {pct100(row.medianPriceReturnPct)}<br />positive {sharePct(row.positiveReturnRate)}<br />ρ {display(row.spearmanSignalPriceReturn, 3)}</div>
    </div>
  );
}

function InfoBlock({ title, icon, rows, footer }: { title: string; icon: ReactNode; rows: Array<[string, string]>; footer?: string }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-elevated/25 p-3">
      <div className="flex items-center gap-2 text-[11px] font-semibold text-content">{icon}<span>{title}</span></div>
      <div className="mt-3 divide-y divide-bg-border/70">
        {rows.map(([label, value]) => <div key={label} className="flex items-center justify-between gap-3 py-1.5 text-[10px]"><span className="text-content-faint">{label}</span><span className="font-mono text-content-muted">{value}</span></div>)}
      </div>
      {footer && <div className="mt-2 border-t border-bg-border pt-2 text-[9px] leading-4 text-content-faint">{footer}</div>}
    </div>
  );
}

function MetricCard({ label, value, note, valueClassName = "text-content" }: { label: string; value: string; note?: string; valueClassName?: string }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-elevated/30 p-3">
      <div className="text-[9px] font-semibold uppercase tracking-[0.11em] text-content-faint">{label}</div>
      <div className={`mt-1.5 break-words text-sm font-semibold ${valueClassName}`}>{value}</div>
      {note && <div className="mt-1 text-[9px] leading-4 text-content-faint">{note}</div>}
    </div>
  );
}

function SectionHeader({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="flex items-start gap-2">
      <div className="mt-0.5 text-primary [&>svg]:h-4 [&>svg]:w-4">{icon}</div>
      <div><div className="text-xs font-semibold text-content">{title}</div>{subtitle && <div className="mt-0.5 text-[9px] leading-4 text-content-faint">{subtitle}</div>}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === "ok" ? "border-green-500/25 bg-green-500/10 text-green-300" : status === "fail" ? "border-danger/25 bg-danger/10 text-danger" : status === "warn" ? "border-warning/25 bg-warning/10 text-warning" : "border-bg-border bg-white/5 text-content-faint";
  return <span className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase ${cls}`}>{status}</span>;
}

function MessageList({ title, items, tone }: { title: string; items: string[]; tone: "warning" | "neutral" }) {
  const cls = tone === "warning" ? "border-warning/20 bg-warning/5" : "border-bg-border bg-bg-elevated/25";
  return (
    <div className={`rounded-xl border p-3 ${cls}`}>
      <div className="text-[10px] font-semibold text-content-muted">{title}</div>
      {items.length ? <div className="mt-2 max-h-80 space-y-1 overflow-auto text-[9px] leading-4 text-content-faint">{items.map((row, index) => <div key={`${index}-${row}`}>• {row}</div>)}</div> : <div className="mt-2 text-[9px] text-content-faint">Нет записей.</div>}
    </div>
  );
}

function Unavailable({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed border-bg-border p-8 text-center text-xs text-content-faint">{text}</div>;
}

function display(value: number | null | undefined, digits = 2): string {
  return finite(value) ? value.toFixed(digits) : "—";
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function nullableYesNo(value: boolean | null | undefined): string {
  return value == null ? "—" : value ? "yes" : "no";
}

function humanize(value: string): string {
  return value
    .replace(/[_\.]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}
