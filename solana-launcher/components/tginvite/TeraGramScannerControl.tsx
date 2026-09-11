"use client";


import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Play,
  RefreshCw,
  Settings2,
  Square,
  Terminal,
} from "lucide-react";


import {
  fetchTeraGramScanStatus,
  startTeraGramScan,
  stopTeraGramScan,
  TeraGramApiError,
  type TeraGramScanJob,
  type TeraGramScanRequest,
} from "@/lib/teragramInvite";


const ACTIVE_STATES = new Set(["starting", "running", "stopping"]);


function numberFromInput(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}


function formattedDate(value?: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("ru-RU");
}


export default function TeraGramScannerControl() {
  const [job, setJob] = useState<TeraGramScanJob | null>(null);
  const [mode, setMode] = useState<"preview" | "full">("preview");
  const [maxChats, setMaxChats] = useState("1000");
  const [seedLimit, setSeedLimit] = useState("250");
  const [threads, setThreads] = useState("4");
  const [memoryLimit, setMemoryLimit] = useState("4GB");
  const [fetchSize, setFetchSize] = useState("10000");
  const [signalSource, setSignalSource] =
    useState<TeraGramScanRequest["signal_source"]>("auto");


  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);


  const active = Boolean(job && ACTIVE_STATES.has(job.status));


  const refreshStatus = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);


    try {
      const next = await fetchTeraGramScanStatus();
      setJob(next);
      setError(null);
      setForbidden(false);
    } catch (cause) {
      if (cause instanceof TeraGramApiError && cause.status === 403) {
        setForbidden(true);
        setError(null);
      } else if (cause instanceof TeraGramApiError && cause.status === 401) {
        setError("Нужна авторизация для управления TeraGram scanner.");
      } else {
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось получить статус TeraGram scanner",
        );
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);


  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);


  useEffect(() => {
    if (!active) return;


    const timer = window.setInterval(() => {
      void refreshStatus(true);
    }, 2000);


    return () => window.clearInterval(timer);
  }, [active, refreshStatus]);


  const progress = Math.min(
    100,
    Math.max(0, Number(job?.progress_percent || 0)),
  );


  const summary = useMemo(() => {
    const value = job?.summary;
    return value && typeof value === "object" ? value : null;
  }, [job?.summary]);


  function changeMode(next: "preview" | "full") {
    setMode(next);


    if (next === "preview" && !maxChats.trim()) {
      setMaxChats("1000");
    }


    if (next === "full" && maxChats === "1000") {
      setMaxChats("");
    }
  }


  async function startScan() {
    setActionLoading(true);
    setError(null);


    try {
      const parsedSeedLimit = numberFromInput(seedLimit);
      const parsedFetchSize = numberFromInput(fetchSize);


      if (!parsedSeedLimit) {
        throw new Error("Seed limit должен быть больше 0.");
      }


      if (!parsedFetchSize) {
        throw new Error("Fetch size должен быть больше 0.");
      }


      const next = await startTeraGramScan({
        mode,
        max_chats: numberFromInput(maxChats),
        seed_limit: parsedSeedLimit,
        signal_source: signalSource,
        threads: numberFromInput(threads),
        memory_limit: memoryLimit.trim().toUpperCase() || "4GB",
        fetch_size: parsedFetchSize,
      });


      setJob(next);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось запустить TeraGram scan",
      );
    } finally {
      setActionLoading(false);
    }
  }


  async function stopScan() {
    setActionLoading(true);
    setError(null);


    try {
      setJob(await stopTeraGramScan());
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось остановить TeraGram scan",
      );
    } finally {
      setActionLoading(false);
    }
  }


  if (forbidden) {
    return (
      <section className="surface-panel rounded-[24px] border border-bg-border p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <Settings2 className="mt-0.5 h-5 w-5 text-content-muted" />
          <div>
            <h3 className="font-bold text-content">TeraGram Scanner Control</h3>
            <p className="mt-1 text-sm text-content-muted">
              Управление полным dataset scanner доступно только superuser.
              Результаты готовой базы можно использовать ниже.
            </p>
          </div>
        </div>
      </section>
    );
  }


  return (
    <section
      data-tag="tginvite.teragram-scanner"
      className="surface-panel relative overflow-hidden rounded-[24px] border border-bg-border p-4 sm:p-5"
    >
      <div className="relative space-y-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-primary-border bg-primary/10 text-primary">
              <Activity className="h-5 w-5" />
            </div>


            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-bold text-content">
                  TeraGram Scanner Control
                </h3>


                <StatusBadge status={job?.status || "idle"} />
              </div>


              <p className="mt-1 max-w-2xl text-sm text-content-muted">
                Анализирует TeraGram через backend DuckDB scanner и создаёт
                source database для TG Invite.
              </p>
            </div>
          </div>


          <button
            type="button"
            onClick={() => void refreshStatus()}
            disabled={loading}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-bg-border bg-bg-soft px-3 text-xs font-semibold text-content-muted transition hover:border-primary-border hover:text-content disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
            Status
          </button>
        </div>


        <div className="grid gap-3 xl:grid-cols-[220px_1fr]">
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-content-faint">
              Scan mode
            </div>


            <div className="grid grid-cols-2 rounded-xl border border-bg-border bg-bg-soft p-1">
              {(["preview", "full"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={active}
                  onClick={() => changeMode(value)}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold capitalize transition ${
                    mode === value
                      ? "bg-primary/15 text-primary"
                      : "text-content-muted hover:text-content"
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>


          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field
              label="Max chats"
              value={maxChats}
              placeholder={mode === "full" ? "без лимита" : "1000"}
              disabled={active}
              onChange={setMaxChats}
            />


            <Field
              label="Seed limit"
              value={seedLimit}
              disabled={active}
              onChange={setSeedLimit}
            />


            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-content-faint">
                Signal source
              </span>
              <select
                value={signalSource}
                disabled={active}
                onChange={(event) =>
                  setSignalSource(
                    event.target.value as TeraGramScanRequest["signal_source"],
                  )
                }
                className="h-10 w-full rounded-xl border border-bg-border bg-bg-soft px-3 text-sm text-content outline-none transition focus:border-primary-border disabled:opacity-50"
              >
                <option value="auto">Auto</option>
                <option value="content">Message content</option>
                <option value="entities">URL / hashtags</option>
                <option value="metadata">Metadata only</option>
              </select>
            </label>
          </div>
        </div>


        <button
          type="button"
          onClick={() => setAdvancedOpen((value) => !value)}
          className="inline-flex items-center gap-2 text-xs font-semibold text-content-muted hover:text-content"
        >
          <Settings2 className="h-3.5 w-3.5" />
          Advanced scanner settings
        </button>


        {advancedOpen && (
          <div className="grid gap-3 rounded-2xl border border-bg-border bg-bg-soft/50 p-4 sm:grid-cols-3">
            <Field
              label="Threads"
              value={threads}
              disabled={active}
              onChange={setThreads}
            />


            <Field
              label="Memory limit"
              value={memoryLimit}
              type="text"
              disabled={active}
              onChange={setMemoryLimit}
            />


            <Field
              label="Fetch size"
              value={fetchSize}
              disabled={active}
              onChange={setFetchSize}
            />
          </div>
        )}


        <div className="rounded-2xl border border-bg-border bg-bg-soft/50 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.14em] text-content-faint">
                Current stage
              </div>
              <div className="mt-1 font-semibold text-content">
                {job?.stage || "idle"}
              </div>
            </div>


            <div className="flex gap-2">
              {!active ? (
                <button
                  type="button"
                  onClick={() => void startScan()}
                  disabled={actionLoading}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-primary-border bg-primary/10 px-4 text-sm font-bold text-primary transition hover:bg-primary/15 disabled:opacity-50"
                >
                  {actionLoading ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  Start Scan
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void stopScan()}
                  disabled={actionLoading || job?.status === "stopping"}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-red-400/30 bg-red-400/10 px-4 text-sm font-bold text-red-300 transition hover:bg-red-400/15 disabled:opacity-50"
                >
                  {actionLoading ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Square className="h-4 w-4" />
                  )}
                  Stop Scan
                </button>
              )}
            </div>
          </div>


          <div className="mt-4 h-2 overflow-hidden rounded-full bg-bg-card">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>


          <div className="mt-2 flex justify-between text-xs text-content-faint">
            <span>{progress}%</span>
            <span>PID: {job?.pid ?? "—"}</span>
          </div>
        </div>


        {error && (
          <div className="flex items-start gap-2 rounded-2xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}


        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Metric
            label="Started"
            value={formattedDate(job?.started_at)}
          />
          <Metric
            label="Finished"
            value={formattedDate(job?.finished_at)}
          />
          <Metric
            label="Mode"
            value={String(job?.config?.mode || mode)}
          />
          <Metric
            label="Memory"
            value={String(job?.config?.memory_limit || memoryLimit)}
          />
        </div>


        {summary && (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Metric
              label="Chats"
              value={String(summary.chats_total ?? "—")}
            />
            <Metric
              label="Prefiltered"
              value={String(summary.prefiltered_chats ?? "—")}
            />
            <Metric
              label="Candidates"
              value={String(summary.candidate_channels ?? "—")}
            />
            <Metric
              label="Seeds"
              value={String(summary.seed_channels ?? "—")}
            />
          </div>
        )}


        <div className="rounded-2xl border border-bg-border bg-[#090b10] p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-content-muted">
            <Terminal className="h-3.5 w-3.5" />
            Scanner log
          </div>


          <div className="max-h-48 overflow-y-auto font-mono text-[11px] leading-5 text-content-muted">
            {job?.logs?.length ? (
              job.logs.slice(-40).map((line, index) => (
                <div key={`${index}-${line}`} className="break-all">
                  {line}
                </div>
              ))
            ) : (
              <div className="text-content-faint">
                Scanner has not produced output yet.
              </div>
            )}
          </div>
        </div>


        {job?.error && (
          <div className="flex items-start gap-2 rounded-2xl border border-red-400/20 bg-red-400/10 p-3 text-xs text-red-200">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{job.error}</span>
          </div>
        )}
      </div>
    </section>
  );
}


function Field({
  label,
  value,
  onChange,
  disabled,
  placeholder,
  type = "number",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  type?: "number" | "text";
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-content-faint">
        {label}
      </span>


      <input
        type={type}
        min={type === "number" ? 1 : undefined}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-xl border border-bg-border bg-bg-soft px-3 text-sm text-content outline-none transition focus:border-primary-border disabled:opacity-50"
      />
    </label>
  );
}


function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-soft/50 p-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-content-faint">
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-bold text-content">
        {value}
      </div>
    </div>
  );
}


function StatusBadge({ status }: { status: string }) {
  const success = status === "succeeded";
  const failed = status === "failed";
  const running = ACTIVE_STATES.has(status);


  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
        success
          ? "border-green-400/20 bg-green-400/10 text-green-300"
          : failed
            ? "border-red-400/20 bg-red-400/10 text-red-300"
            : running
              ? "border-primary-border bg-primary/10 text-primary"
              : "border-bg-border bg-bg-soft text-content-muted"
      }`}
    >
      {success ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : failed ? (
        <AlertCircle className="h-3 w-3" />
      ) : running ? (
        <RefreshCw className="h-3 w-3 animate-spin" />
      ) : (
        <Activity className="h-3 w-3" />
      )}


      {status}
    </span>
  );
}
