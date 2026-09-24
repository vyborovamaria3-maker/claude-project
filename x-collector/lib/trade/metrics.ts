import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import { q, q1 } from "./pg";
import { activeWorkerCount } from "./worker-registry";

export const registry = new Registry();
try { collectDefaultMetrics({ register: registry, prefix: "collector_" }); } catch {}

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

