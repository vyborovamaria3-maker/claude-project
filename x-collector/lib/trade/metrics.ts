import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import { q, q1 } from "./pg";
import { activeWorkerCount } from "./worker-registry";

export const registry = new Registry();
try { collectDefaultMetrics({ register: registry, prefix: "collector_" }); } catch { /* metrics are best-effort */ }

export const tasksTotal = new Counter({
  name: "x_tasks_total", help: "Всего задач по результату",
  labelNames: ["kind", "result"] as const, registers: [registry],
});

export const taskDuration = new Histogram({
  name: "x_task_duration_seconds", help: "Длительность задачи",
  labelNames: ["kind"] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300], registers: [registry],
});

export const queueDepth = new Gauge({
  name: "x_queue_depth", help: "Глубина очереди по статусам",
  labelNames: ["status"] as const, registers: [registry],
});

export const dlqSize = new Gauge({
  name: "x_tasks_dlq_size", help: "Неразобранные в DLQ", registers: [registry],
});

export const workersActive = new Gauge({
  name: "x_workers_active", help: "Активные воркеры", registers: [registry],
});

export const accountStatus = new Gauge({
  name: "x_account_status", help: "Количество аккаунтов по статусу и tier",
  labelNames: ["tier", "status"] as const, registers: [registry],
});

export const redisFallback = new Counter({
  name: "x_redis_fallback_total", help: "Сколько раз свалились на Postgres", registers: [registry],
});

export const schedulerTicks = new Counter({
  name: "x_scheduler_ticks_total", help: "Тики планировщика по задаче и результату",
  labelNames: ["task", "result"] as const, registers: [registry],
});

export const schedulerDuration = new Histogram({
  name: "x_scheduler_task_duration_seconds", help: "Длительность фоновой задачи планировщика",
  labelNames: ["task"] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 900, 3600], registers: [registry],
});

export const schedulerRunning = new Gauge({
  name: "x_scheduler_running", help: "1 если планировщик работает, 0 при завершении", registers: [registry],
});

schedulerRunning.set(1);

export const httpRequests = new Counter({
  name: "x_http_requests_total", help: "HTTP-запросы дашборда/метрик",
  labelNames: ["service", "route", "status"] as const, registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: "x_http_request_duration_seconds", help: "Длительность HTTP-запросов",
  labelNames: ["service", "route"] as const,
  buckets: [0.005, 0.025, 0.1, 0.5, 1, 3, 10], registers: [registry],
});

export const scrapeDuration = new Histogram({
  name: "x_scrape_duration_seconds", help: "Длительность сбора (Playwright) по виду задачи",
  labelNames: ["kind"] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300], registers: [registry],
});

export function sanitizeLabel(v: string): string {
  return v.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 128);
}

export function startMetricsCollector(intervalMs = 15_000): () => void {
  const collect = async () => {
    try {
      const statuses = await q<{ status: string; n: number }>(
        `SELECT status, COUNT(*)::int AS n FROM x_tasks GROUP BY status`
      );
      queueDepth.reset();
      for (const s of statuses) queueDepth.set({ status: sanitizeLabel(s.status) }, s.n);

      const dlq = await q1<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM x_tasks_dlq WHERE reviewed_at IS NULL`
      );
      dlqSize.set(dlq?.n ?? 0);

      workersActive.set(await activeWorkerCount());

      const accs = await q<{ tier: string; status: string; n: number }>(
        `SELECT tier, status, COUNT(*)::int AS n FROM x_accounts GROUP BY tier, status`
      );
      accountStatus.reset();
      for (const a of accs) {
        accountStatus.set({ tier: sanitizeLabel(a.tier), status: sanitizeLabel(a.status) }, a.n);
      }
    } catch {
      // метрики не валят процесс
    }
  };
  const t = setInterval(collect, intervalMs);
  collect().catch(() => {});
  return () => clearInterval(t);
}

