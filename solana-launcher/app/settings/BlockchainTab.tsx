"use client";

import { useEffect, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Database, ExternalLink, Loader2, RefreshCw, ShieldCheck } from "lucide-react";

type RpcHealth = {
  status?: string;
  latency?: number | null;
};

type HealthState = {
  state: "checking" | "ok" | "degraded" | "error";
  latency: number | null;
  checkedAt: string | null;
  error: string | null;
};

const SOURCES = [
  {
    title: "Мигрировавшие токены",
    description: "Входные списки токенов, перешедших с launch-платформ на DEX.",
    label: "migrated",
  },
  {
    title: "DEX Trending",
    description: "Токены из трендов для последующей проверки on-chain активности.",
    label: "trending",
  },
  {
    title: "Профитные кошельки",
    description: "Списки кошельков для сопоставления сделок и источников финансирования.",
    label: "wallets",
  },
] as const;

const INITIAL_HEALTH: HealthState = {
  state: "checking",
  latency: null,
  checkedAt: null,
  error: null,
};

export default function BlockchainTab() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [health, setHealth] = useState<HealthState>(INITIAL_HEALTH);

  useEffect(() => {
    const controller = new AbortController();

    async function checkHealth() {
      setHealth({ state: "checking", latency: null, checkedAt: null, error: null });

      try {
        const response = await fetch("/api/rpc-health", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("RPC health API: HTTP " + response.status);
        }

        const payload = (await response.json()) as RpcHealth;
        if (controller.signal.aborted) return;
        const healthy = payload.status === "ok";
        setHealth({
          state: healthy ? "ok" : "degraded",
          latency: typeof payload.latency === "number" && Number.isFinite(payload.latency)
            ? payload.latency
            : null,
          checkedAt: new Date().toLocaleString("ru-RU"),
          error: null,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setHealth({
          state: "error",
          latency: null,
          checkedAt: new Date().toLocaleString("ru-RU"),
          error: error instanceof Error ? error.message : "Не удалось проверить RPC",
        });
      }
    }

    void checkHealth();
    return () => controller.abort();
  }, [refreshKey]);

  const checking = health.state === "checking";
  const healthy = health.state === "ok";

  return (
    <div data-tag="settings.blockchain" className="space-y-6">
      <header className="surface-panel px-5 py-5 sm:px-6">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" aria-hidden="true" />
          <h2 className="text-lg font-bold text-content">Блокчейн · Solana</h2>
        </div>
        <p className="mt-2 text-sm leading-6 text-content-muted">
          Состояние RPC, входные наборы данных и переходы к on-chain аналитике.
          Серверные ключи и конфигурация сборщика здесь не изменяются.
        </p>
      </header>

      <section className="surface-panel space-y-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-content">Подключение к Solana RPC</h3>
            <p className="mt-1 text-xs text-content-muted">
              Проверяется действующий RPC сервера через /api/rpc-health, без передачи ключей в браузер.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setRefreshKey((value) => value + 1)}
            disabled={checking}
            className="inline-flex items-center gap-2 rounded-xl border border-bg-border bg-bg-soft px-4 py-2 text-sm text-content transition hover:border-primary-border disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw className={"h-4 w-4 " + (checking ? "animate-spin" : "")} aria-hidden="true" />
            Проверить снова
          </button>
        </div>

        <div
          role="status"
          aria-live="polite"
          className={"rounded-xl border px-4 py-4 " + (
            checking ? "border-bg-border bg-bg-soft" :
            healthy ? "border-green-500/30 bg-green-500/10" :
            "border-amber-500/30 bg-amber-500/10"
          )}
        >
          <div className="flex items-start gap-3">
            {checking
              ? <Loader2 className="mt-0.5 h-5 w-5 animate-spin text-content-muted" aria-hidden="true" />
              : healthy
                ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-green-400" aria-hidden="true" />
                : <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-400" aria-hidden="true" />}
            <div>
              <p className="font-semibold text-content">
                {checking ? "Проверка подключения…" :
                  healthy ? "Solana RPC доступен" :
                  health.state === "degraded" ? "Solana RPC деградировал" : "Не удалось проверить RPC"}
              </p>
              <p className="mt-1 text-sm text-content-muted">
                {health.error ||
                  (checking ? "Ожидание ответа сервера." :
                    health.latency !== null ? "Задержка: " + health.latency + " мс" :
                      "Задержка не определена.")}
              </p>
              {health.checkedAt && (
                <p className="mt-1 text-xs text-content-muted">Проверено: {health.checkedAt}</p>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="surface-panel space-y-4 p-5 sm:p-6">
        <div>
          <h3 className="text-base font-semibold text-content">Источники для блокчейн-аналитики</h3>
          <p className="mt-1 text-sm text-content-muted">
            Три типа исходных наборов. Это описание входных данных, а не индикатор запущенного импорта.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {SOURCES.map((source) => (
            <div key={source.label} className="rounded-xl border border-bg-border bg-bg-soft p-4">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-primary" aria-hidden="true" />
                <p className="font-medium text-content">{source.title}</p>
              </div>
              <p className="mt-2 text-sm leading-6 text-content-muted">{source.description}</p>
              <code className="mt-3 inline-block rounded-md border border-bg-border px-2 py-1 text-xs text-content-muted">
                {source.label}
              </code>
            </div>
          ))}
        </div>
        <p className="text-xs leading-5 text-content-muted">
          Фактическое наличие записей и полноту истории проверяйте в базе данных.
          Отсутствие найденных подозрительных сделок при неполных данных не доказывает их отсутствие.
        </p>
      </section>

      <section className="surface-panel space-y-3 p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
          <h3 className="text-base font-semibold text-content">Конфигурация источников</h3>
        </div>
        <p className="text-sm leading-6 text-content-muted">
          Активный RPC выбирается сервером в следующем порядке. Чтобы изменить подключение,
          обновите переменные окружения приложения и перезапустите его.
        </p>
        <div className="rounded-xl border border-bg-border bg-bg-soft p-4 text-xs leading-7 text-content-muted">
          <code className="break-all">HELIUS_RPC_URL → NEXT_PUBLIC_HELIUS_RPC_URL → RPC_URL → NEXT_PUBLIC_RPC_URL → Solana mainnet public RPC</code>
        </div>
        <p className="text-xs leading-5 text-content-muted">
          Секретные API-ключи храните в серверных переменных окружения, а не в NEXT_PUBLIC_*.
          Вкладка не показывает значения ключей и не сохраняет настройки в браузере.
        </p>
      </section>

      <section className="surface-panel space-y-3 p-5 sm:p-6">
        <h3 className="text-base font-semibold text-content">Данные и аналитика</h3>
        <div className="flex flex-wrap gap-3">
          <a href="/database" className="inline-flex items-center gap-2 rounded-xl border border-primary-border bg-bg-soft px-4 py-2 text-sm font-medium text-content hover:opacity-80">
            <Database className="h-4 w-4" aria-hidden="true" /> Базы данных <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
          <a href="/intelligence" className="inline-flex items-center gap-2 rounded-xl border border-bg-border bg-bg-soft px-4 py-2 text-sm font-medium text-content hover:border-primary-border">
            <Activity className="h-4 w-4" aria-hidden="true" /> Blockchain Intelligence <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
      </section>
    </div>
  );
}
