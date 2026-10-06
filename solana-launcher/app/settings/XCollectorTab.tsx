"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Loader2, Play, RefreshCw, Square, TerminalSquare } from "lucide-react";
import { useCachedValue, writeCachedValue } from "@/lib/client-cache";
import { useQuery } from "@/lib/react-query";

type ProcessRecord = { pid: number; startedAt: number; command: string };

type XCollectorSummary = {
  installed: boolean;
  dirExists: boolean;
  nodeModulesPresent: boolean;
  env: {
    databaseUrlConfigured: boolean;
    masterKeyConfigured: boolean;
  };
  migrations: {
    complete: boolean;
    missing: string[];
    path: string;
  };
  processes: {
    worker: ProcessRecord | null;
    scheduler: ProcessRecord | null;
    dashboard: ProcessRecord | null;
  };
  health: {
    worker: { url: string; reachable: boolean; detail: string };
    dashboard: { url: string; reachable: boolean; detail: string };
  };
  db: {
    reachable: boolean;
    detail: string;
  };
};

const X_COLLECTOR_SUMMARY_CACHE_KEY = "solana-launcher.xcollector-summary.v1";
const X_COLLECTOR_SUMMARY_CACHE_TTL_MS = 15_000;
const QUERY_KEY = ["x-collector-summary"] as const;

async function fetchSummary(): Promise<XCollectorSummary> {
  const response = await fetch("/api/integrations/x-collector", { cache: "no-store" });
  const json = await response.json();
  if (!response.ok) throw new Error(json?.error || "Failed to load X Collector summary");
  return json as XCollectorSummary;
}

async function runAction(action: string): Promise<{ output?: string }> {
  const response = await fetch("/api/integrations/x-collector", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json?.error || "Failed to run action");
  return json as { output?: string };
}

function StatusPill({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "fail" | "neutral" }) {
  const toneClass = tone === "ok"
    ? "border-green-500/30 bg-green-500/10 text-green-300"
    : tone === "warn"
      ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-100"
      : tone === "fail"
        ? "border-red-500/30 bg-red-500/10 text-red-300"
        : "border-white/10 bg-white/5 text-white/70";
  return (
    <div className={`rounded-xl border px-4 py-3 ${toneClass}`}>
      <p className="text-[11px] uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 text-sm font-semibold break-all">{value}</p>
    </div>
  );
}

function ProcessCard({ name, label, description, running, health, busy, onStart, onStop }: {
  name: string;
  label: string;
  description: string;
  running: boolean;
  health?: { url: string; reachable: boolean; detail: string };
  busy: string | null;
  onStart: () => void;
  onStop: () => void;
}) {
  const healthOk = health?.reachable === true;
  return (
    <div className="glass rounded-xl border border-bg-border p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-white">
          <TerminalSquare className="w-4 h-4 text-neon-green" />
          <p className="font-semibold">{label}</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${running ? "border-green-500/30 bg-green-500/10 text-green-300" : "border-white/10 bg-white/5 text-white/50"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${running ? "bg-green-400" : "bg-white/30"}`} />
          {running ? "running" : "stopped"}
        </span>
      </div>
      <p className="text-xs text-white/40">{description}</p>
      {health && (
        <p className={`text-xs ${healthOk ? "text-green-300" : "text-white/40"}`}>
          {healthOk ? `Health OK · ${health.detail}` : "Health недоступен"}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onStart}
          disabled={busy !== null || running}
          className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold bg-neon-green/10 border border-neon-green/40 text-neon-green hover:bg-neon-green/20 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === `${name}-start` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          Start
        </button>
        <button
          type="button"
          onClick={onStop}
          disabled={busy !== null || !running}
          className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold border border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === `${name}-stop` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
          Stop
        </button>
      </div>
    </div>
  );
}

export default function XCollectorTab() {
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const cachedSummary = useCachedValue<XCollectorSummary>(X_COLLECTOR_SUMMARY_CACHE_KEY);
  const summaryQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchSummary,
    initialData: cachedSummary ?? undefined,
    staleTime: X_COLLECTOR_SUMMARY_CACHE_TTL_MS,
    gcTime: 5 * 60_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (summaryQuery.data) {
      writeCachedValue(X_COLLECTOR_SUMMARY_CACHE_KEY, summaryQuery.data, X_COLLECTOR_SUMMARY_CACHE_TTL_MS);
    }
  }, [summaryQuery.data]);

  const summary = summaryQuery.data ?? null;
  const loading = summaryQuery.isPending && !summary;

  const readiness = useMemo(() => {
    if (!summary) return { status: "checking", text: "Загружаю состояние X Collector..." };
    if (!summary.dirExists) return { status: "fail", text: "Папка x-collector не найдена." };
    if (!summary.nodeModulesPresent) return { status: "warn", text: "Зависимости не установлены." };
    if (!summary.env.databaseUrlConfigured) return { status: "warn", text: "Нужен DATABASE_URL." };
    if (!summary.env.masterKeyConfigured) return { status: "warn", text: "Нужен MASTER_KEY." };
    if (!summary.migrations.complete) return { status: "warn", text: `Миграции неполные: ${summary.migrations.missing.join(", ")}.` };
    if (!summary.db.reachable) return { status: "warn", text: `БД недоступна: ${summary.db.detail}.` };
    return { status: "ok", text: "X Collector готов к работе." };
  }, [summary]);

  const isRunning = (name: "worker" | "scheduler" | "dashboard") => Boolean(summary?.processes?.[name]);

  async function dispatch(action: string) {
    setBusyAction(action);
    setActionError(null);
    try {
      const result = await runAction(action);
      await summaryQuery.refetch();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Ошибка действия");
    } finally {
      setBusyAction(null);
    }
  }

  // Mapping modules to sections
  const moduleSectionMapping: Record<string, string> = {
    "Аккаунты": "accounts",
    "Прокси": "proxies",
    "Кампании": "campaigns",
    "AI генерация": "ai",
    "Anti-detection": "security",
  };

  const handleModuleClick = (feature: string) => {
    const section = moduleSectionMapping[feature];
    if (section) {
      window.location.href = `#${section}`;
    } else {
      // Not implemented yet
      alert(`Модуль "${feature}" находится в разработке`);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-white">X Collector</h2>
        <p className="text-sm text-white/40 mt-0.5">
          Автоматический сборщик твитов и AI-агрегатор для Solana.
        </p>
      </div>

      {actionError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      <div className="glass rounded-xl border border-bg-border p-5 md:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-white">Готовность системы</p>
            <p className="text-xs text-white/40 mt-0.5">Интеграция x-collector, зависимости, конфигурация.</p>
          </div>
          <button
            type="button"
            onClick={() => void summaryQuery.refetch()}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-xs text-white/70 hover:text-white hover:border-white/20 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${summaryQuery.isFetching ? "animate-spin" : ""}`} />
            Обновить
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <StatusPill label="Установлен" value={summary ? (summary.installed ? "Да" : "Нет") : "—"} tone={summary?.installed ? "ok" : "fail"} />
          <StatusPill label="DATABASE_URL" value={summary?.env.databaseUrlConfigured ? "Настроен" : "Отсутствует"} tone={summary?.env.databaseUrlConfigured ? "ok" : "warn"} />
          <StatusPill label="MASTER_KEY" value={summary?.env.masterKeyConfigured ? "Настроен" : "Отсутствует"} tone={summary?.env.masterKeyConfigured ? "ok" : "warn"} />
          <StatusPill label="БД Доступна" value={summary?.db.reachable ? "OK" : "Нет"} tone={summary?.db.reachable ? "ok" : "warn"} />
        </div>

        <div className={`rounded-xl border px-4 py-3 text-sm ${readiness.status === "ok" ? "border-green-500/30 bg-green-500/10 text-green-200" : readiness.status === "warn" ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-100" : readiness.status === "fail" ? "border-red-500/30 bg-red-500/10 text-red-200" : "border-white/10 bg-white/5 text-white/60"}`}>
          {readiness.text}
        </div>
      </div>

      <div className="glass rounded-xl border border-bg-border p-5 space-y-4">
        <div className="flex items-center gap-2 text-white">
          <TerminalSquare className="w-4 h-4 text-neon-green" />
          <p className="font-semibold">Активные процессы</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {["worker", "scheduler", "dashboard"].map((name) => (
            <ProcessCard 
              key={name} 
              name={name}
              label={name === "worker" ? "Worker" : name === "scheduler" ? "Scheduler" : "Dashboard"}
              description={name === "worker" ? "Очередь и обработка твитов" : name === "scheduler" ? "Планировщик задач" : "HTTP-интерфейс"}
              running={isRunning(name as any)}
              health={name === "dashboard" ? summary?.health.dashboard : undefined}
              busy={busyAction}
              onStart={() => void dispatch(`${name}-start`)}
              onStop={() => void dispatch(`${name}-stop`)}
            />
          ))}
        </div>
      </div>

      <div className="glass rounded-xl border border-bg-border p-6">
        <h3 className="text-lg font-semibold text-white mb-4">Модули системы</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {["Аккаунты", "Прокси", "Кампании", "AI генерация", "RAG", "Rate limiting", "Anti-detection", "Telegram-бот"].map((feature) => (
            <button
              key={feature}
              onClick={() => handleModuleClick(feature)}
              type="button"
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-sm text-white/70 hover:bg-white/10 transition cursor-pointer w-full text-left"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>{feature}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Секции с id для якорной навигации */}
      <div id="overview" className="space-y-6">
        <h2 className="text-2xl font-bold text-white">Обзор</h2>
        <p className="text-sm text-white/40">Главная панель мониторинга.</p>
      </div>
      <div id="accounts" className="space-y-6">
        <h2 className="text-2xl font-bold text-white">Аккаунты</h2>
        <p className="text-sm text-white/40">Управление X-аккаунтами.</p>
      </div>
      <div id="proxies" className="space-y-6">
        <h2 className="text-2xl font-bold text-white">Прокси</h2>
        <p className="text-sm text-white/40">Настройки прокси-серверов.</p>
      </div>
      <div id="campaigns" className="space-y-6">
        <h2 className="text-2xl font-bold text-white">Кампании</h2>
        <p className="text-sm text-white/40">Управление кампаниями.</p>
      </div>
      <div id="ai" className="space-y-6">
        <h2 className="text-2xl font-bold text-white">AI генерация</h2>
        <p className="text-sm text-white/40">Настройки LLM.</p>
      </div>
      <div id="security" className="space-y-6">
        <h2 className="text-2xl font-bold text-white">Безопасность</h2>
        <p className="text-sm text-white/40">Anti-detection и rate limiting.</p>
      </div>
    </div>
  );
}

