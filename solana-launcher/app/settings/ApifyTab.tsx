"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Database, ExternalLink, Loader2, Play, RefreshCw, Rocket, ShieldCheck } from "lucide-react";
import { useCachedValue, writeCachedValue } from "@/lib/client-cache";
import { useQuery } from "@/lib/react-query";

type PublicRun = {
  runId: string;
  actorId: string;
  actorType: string;
  status: string;
  defaultDatasetId: string | null;
  startedAt: number;
  finishedAt: number | null;
  input: unknown;
  meta: unknown;
  lastSyncedAt: number;
  urls: {
    base: string;
    shell: string;
    mcp: string;
  };
};

type SyncEvent = {
  id?: number;
  source: string;
  runId: string | null;
  datasetId: string | null;
  status: string;
  importedItems: number;
  importedCreators: number;
  importedTokens: number;
  message: string | null;
  meta: unknown;
  createdAt?: number;
};

type ApifySummary = {
  config: {
    tokenConfigured: boolean;
    apiBaseUrl: string;
    sandboxActorId: string;
    pumpfunActorId: string;
  };
  latestSandboxRun: PublicRun | null;
  latestPumpfunRun: PublicRun | null;
  recentRuns: PublicRun[];
  recentSyncs: SyncEvent[];
};

const defaultSandboxJson = JSON.stringify({}, null, 2);
const APIFY_SUMMARY_CACHE_KEY = "solana-launcher.apify-summary.v1";
const APIFY_SUMMARY_CACHE_TTL_MS = 60_000;
const APIFY_SUMMARY_QUERY_KEY = ["apify-summary"] as const;

async function fetchApifySummary(): Promise<ApifySummary> {
  const response = await fetch("/api/integrations/apify", { cache: "no-store" });
  const json = await response.json();
  if (!response.ok) throw new Error(json?.error || "Failed to load Apify summary");
  return json as ApifySummary;
}

function formatDate(value: number | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function runTone(status: string) {
  const normalized = status.toUpperCase();
  if (normalized === "SUCCEEDED" || normalized === "READY") return "text-green-400 border-green-500/30 bg-green-500/10";
  if (normalized === "RUNNING") return "text-yellow-300 border-yellow-500/30 bg-yellow-500/10";
  if (normalized === "FAILED" || normalized === "ABORTED" || normalized === "TIMED-OUT") return "text-red-300 border-red-500/30 bg-red-500/10";
  return "text-white/60 border-white/10 bg-white/5";
}

export default function ApifyTab() {
  const cachedSummary = useCachedValue<ApifySummary>(APIFY_SUMMARY_CACHE_KEY);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sandboxJson, setSandboxJson] = useState(defaultSandboxJson);
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [ingestBusy, setIngestBusy] = useState(false);
  const [manualDatasetId, setManualDatasetId] = useState("");
  const [syncForm, setSyncForm] = useState({
    maxItems: 100,
    sortBy: "last_trade_timestamp",
    order: "DESC" as "ASC" | "DESC",
    includeNsfw: false,
    includeDetails: true,
  });

  const summaryQuery = useQuery({
    queryKey: APIFY_SUMMARY_QUERY_KEY,
    queryFn: fetchApifySummary,
    initialData: cachedSummary ?? undefined,
    staleTime: APIFY_SUMMARY_CACHE_TTL_MS,
    gcTime: 5 * 60_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (summaryQuery.data) {
      writeCachedValue(APIFY_SUMMARY_CACHE_KEY, summaryQuery.data, APIFY_SUMMARY_CACHE_TTL_MS);
    }
  }, [summaryQuery.data]);

  const summary = summaryQuery.data ?? null;
  const loading = summaryQuery.isPending && !summary;
  const error = actionError ?? (summaryQuery.error instanceof Error ? summaryQuery.error.message : null);

  const latestSandboxRun = summary?.latestSandboxRun ?? null;
  const latestPumpfunRun = summary?.latestPumpfunRun ?? null;
  const canIngestLatestDataset = Boolean(latestPumpfunRun?.defaultDatasetId);

  const readiness = useMemo(() => {
    if (!summary) return { status: "checking", text: "Загружаю конфигурацию..." };
    if (!summary.config.tokenConfigured) return { status: "warn", text: "Нужен APIFY_API_TOKEN для запуска actor runs." };
    return { status: "ok", text: "Apify готов: можно запускать sandbox и Pump.fun scraper." };
  }, [summary]);

  async function startSandbox() {
    setSandboxBusy(true);
    setActionError(null);
    try {
      const input = JSON.parse(sandboxJson);
      const response = await fetch("/api/integrations/apify/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json?.error || "Failed to start sandbox");
      await summaryQuery.refetch();
    } catch (nextError) {
      setActionError(nextError instanceof Error ? nextError.message : "Failed to start sandbox");
    } finally {
      setSandboxBusy(false);
    }
  }

  async function startSync() {
    setSyncBusy(true);
    setActionError(null);
    try {
      const response = await fetch("/api/integrations/apify/pumpfun-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", input: syncForm }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json?.error || "Failed to start scraper run");
      await summaryQuery.refetch();
    } catch (nextError) {
      setActionError(nextError instanceof Error ? nextError.message : "Failed to start scraper run");
    } finally {
      setSyncBusy(false);
    }
  }

  async function refreshRun(runId: string) {
    try {
      const response = await fetch(`/api/integrations/apify/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json?.error || "Failed to refresh run");
      await summaryQuery.refetch();
    } catch (nextError) {
      setActionError(nextError instanceof Error ? nextError.message : "Failed to refresh run");
    }
  }

  async function ingestDataset(datasetId: string, runId?: string | null) {
    setIngestBusy(true);
    setActionError(null);
    try {
      const response = await fetch("/api/integrations/apify/pumpfun-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ingest", datasetId, runId }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json?.error || "Failed to ingest dataset");
      setManualDatasetId("");
      await summaryQuery.refetch();
    } catch (nextError) {
      setActionError(nextError instanceof Error ? nextError.message : "Failed to ingest dataset");
    } finally {
      setIngestBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-white">Apify</h2>
        <p className="text-sm text-white/40 mt-0.5">
          Полная интеграция: запуск AI sandbox, управление actor runs и импорт Pump.fun dataset в локальную SQLite.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="glass rounded-xl border border-bg-border p-5 md:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-white">Integration readiness</p>
            <p className="text-xs text-white/40 mt-0.5">Server-side токен, actor IDs и последний known state.</p>
          </div>
          <button
            type="button"
            onClick={() => void summaryQuery.refetch()}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-xs text-white/70 hover:text-white hover:border-white/20 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${summaryQuery.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <StatusPill label="Token" value={summary?.config.tokenConfigured ? "Configured" : "Missing"} tone={summary?.config.tokenConfigured ? "ok" : "warn"} />
          <StatusPill label="Sandbox Actor" value={summary?.config.sandboxActorId ?? "—"} tone="neutral" />
          <StatusPill label="Pump.fun Actor" value={summary?.config.pumpfunActorId ?? "—"} tone="neutral" />
        </div>

        <div className={`rounded-xl border px-4 py-3 text-sm ${readiness.status === "ok" ? "border-green-500/30 bg-green-500/10 text-green-200" : readiness.status === "warn" ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-100" : "border-white/10 bg-white/5 text-white/60"}`}>
          {readiness.text}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="glass rounded-xl border border-bg-border p-5 space-y-4">
          <div className="flex items-center gap-2 text-white">
            <Rocket className="w-4 h-4 text-neon-green" />
            <p className="font-semibold">Apify AI Sandbox</p>
          </div>

          <textarea
            value={sandboxJson}
            onChange={(event) => setSandboxJson(event.target.value)}
            spellCheck={false}
            className="w-full min-h-[180px] rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-xs font-mono text-white/80 focus:outline-none focus:border-neon-green/40"
          />

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void startSandbox()}
              disabled={sandboxBusy || !summary?.config.tokenConfigured}
              className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold bg-neon-green/10 border border-neon-green/40 text-neon-green hover:bg-neon-green/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {sandboxBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Start Sandbox
            </button>
            {latestSandboxRun && (
              <button
                type="button"
                onClick={() => void refreshRun(latestSandboxRun.runId)}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold border border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20"
              >
                <RefreshCw className="w-4 h-4" />
                Refresh Run
              </button>
            )}
          </div>

          <RunCard title="Latest sandbox run" run={latestSandboxRun} />
        </div>

        <div className="glass rounded-xl border border-bg-border p-5 space-y-4">
          <div className="flex items-center gap-2 text-white">
            <Database className="w-4 h-4 text-neon-green" />
            <p className="font-semibold">Pump.fun database sync</p>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="space-y-1">
              <span className="text-white/50">Max items</span>
              <input
                type="number"
                min={1}
                max={1000}
                value={syncForm.maxItems}
                onChange={(event) => setSyncForm((current) => ({ ...current, maxItems: Number(event.target.value) || 100 }))}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-white focus:outline-none focus:border-neon-green/40"
              />
            </label>
            <label className="space-y-1">
              <span className="text-white/50">Order</span>
              <select
                value={syncForm.order}
                onChange={(event) => setSyncForm((current) => ({ ...current, order: event.target.value as "ASC" | "DESC" }))}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-white focus:outline-none focus:border-neon-green/40"
              >
                <option value="DESC">DESC</option>
                <option value="ASC">ASC</option>
              </select>
            </label>
            <label className="space-y-1 col-span-2">
              <span className="text-white/50">Sort by</span>
              <input
                value={syncForm.sortBy}
                onChange={(event) => setSyncForm((current) => ({ ...current, sortBy: event.target.value }))}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-white focus:outline-none focus:border-neon-green/40"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-5 text-sm text-white/70">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={syncForm.includeDetails} onChange={(event) => setSyncForm((current) => ({ ...current, includeDetails: event.target.checked }))} />
              Include details
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={syncForm.includeNsfw} onChange={(event) => setSyncForm((current) => ({ ...current, includeNsfw: event.target.checked }))} />
              Include NSFW
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void startSync()}
              disabled={syncBusy || !summary?.config.tokenConfigured}
              className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold bg-neon-green/10 border border-neon-green/40 text-neon-green hover:bg-neon-green/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {syncBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Start Scraper Run
            </button>
            {latestPumpfunRun && (
              <button
                type="button"
                onClick={() => void refreshRun(latestPumpfunRun.runId)}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold border border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20"
              >
                <RefreshCw className="w-4 h-4" />
                Refresh Run
              </button>
            )}
            {canIngestLatestDataset && latestPumpfunRun?.defaultDatasetId && (
              <button
                type="button"
                onClick={() => void ingestDataset(latestPumpfunRun.defaultDatasetId!, latestPumpfunRun.runId)}
                disabled={ingestBusy}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold border border-neon-green/30 bg-neon-green/5 text-neon-green hover:bg-neon-green/10 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {ingestBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
                Ingest Latest Dataset
              </button>
            )}
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
            <p className="text-sm font-semibold text-white">Manual dataset ingest</p>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                value={manualDatasetId}
                onChange={(event) => setManualDatasetId(event.target.value)}
                placeholder="Dataset ID"
                className="flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white focus:outline-none focus:border-neon-green/40"
              />
              <button
                type="button"
                onClick={() => void ingestDataset(manualDatasetId)}
                disabled={!manualDatasetId.trim() || ingestBusy}
                className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold border border-white/10 bg-white/5 text-white/80 hover:text-white hover:border-white/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {ingestBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
                Ingest
              </button>
            </div>
          </div>

          <RunCard title="Latest scraper run" run={latestPumpfunRun} />
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="glass rounded-xl border border-bg-border p-5 space-y-4">
          <div className="flex items-center gap-2 text-white">
            <ShieldCheck className="w-4 h-4 text-neon-green" />
            <p className="font-semibold">Recent actor runs</p>
          </div>
          <div className="space-y-3">
            {(summary?.recentRuns ?? []).map((run) => (
              <div key={run.runId} className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-white">{run.actorType}</p>
                    <p className="text-xs text-white/40">{run.actorId}</p>
                  </div>
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${runTone(run.status)}`}>
                    {run.status}
                  </span>
                </div>
                <div className="text-xs text-white/50 space-y-1">
                  <p>Run ID: <span className="text-white/80 font-mono">{run.runId}</span></p>
                  <p>Started: <span className="text-white/80">{formatDate(run.startedAt)}</span></p>
                  {run.defaultDatasetId && <p>Dataset: <span className="text-white/80 font-mono">{run.defaultDatasetId}</span></p>}
                </div>
              </div>
            ))}
            {!summary?.recentRuns?.length && !loading && <EmptyState text="Actor runs ещё не запускались." />}
          </div>
        </div>

        <div className="glass rounded-xl border border-bg-border p-5 space-y-4">
          <div className="flex items-center gap-2 text-white">
            <CheckCircle2 className="w-4 h-4 text-neon-green" />
            <p className="font-semibold">Recent sync history</p>
          </div>
          <div className="space-y-3">
            {(summary?.recentSyncs ?? []).map((event) => (
              <div key={`${event.id ?? event.createdAt}-${event.datasetId ?? "none"}`} className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-white">{event.status}</p>
                  <p className="text-xs text-white/40">{formatDate(event.createdAt)}</p>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <Metric label="Items" value={String(event.importedItems)} />
                  <Metric label="Creators" value={String(event.importedCreators)} />
                  <Metric label="Tokens" value={String(event.importedTokens)} />
                </div>
                {event.message && <p className="text-xs text-white/60">{event.message}</p>}
                {event.datasetId && <p className="text-xs text-white/40">Dataset: <span className="font-mono text-white/80">{event.datasetId}</span></p>}
              </div>
            ))}
            {!summary?.recentSyncs?.length && !loading && <EmptyState text="История sync ещё пуста." />}
          </div>
        </div>
      </div>
    </div>
  );
}

function RunCard({ title, run }: { title: string; run: PublicRun | null }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
      <p className="text-sm font-semibold text-white">{title}</p>
      {!run && <EmptyState text="Запусков пока нет." />}
      {run && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${runTone(run.status)}`}>
              {run.status}
            </span>
            <span className="text-xs text-white/40">{formatDate(run.startedAt)}</span>
          </div>
          <div className="space-y-1 text-xs text-white/50">
            <p>Run ID: <span className="font-mono text-white/80">{run.runId}</span></p>
            <p>Actor: <span className="text-white/80">{run.actorId}</span></p>
            {run.defaultDatasetId && <p>Dataset: <span className="font-mono text-white/80">{run.defaultDatasetId}</span></p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <RunLink href={run.urls.base} label="Base URL" />
            <RunLink href={run.urls.shell} label="Shell" />
            <RunLink href={run.urls.mcp} label="MCP" />
          </div>
        </>
      )}
    </div>
  );
}

function RunLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/70 hover:text-white hover:border-white/20"
    >
      <ExternalLink className="w-3.5 h-3.5" />
      {label}
    </a>
  );
}

function StatusPill({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "neutral" }) {
  const toneClass = tone === "ok"
    ? "border-green-500/30 bg-green-500/10 text-green-300"
    : tone === "warn"
      ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-100"
      : "border-white/10 bg-white/5 text-white/70";
  return (
    <div className={`rounded-xl border px-4 py-3 ${toneClass}`}>
      <p className="text-[11px] uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 text-sm font-semibold break-all">{value}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
      <p className="text-white/40">{label}</p>
      <p className="font-semibold text-white mt-1">{value}</p>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="text-sm text-white/35">{text}</p>;
}
