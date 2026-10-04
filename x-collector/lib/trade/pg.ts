import "dotenv/config";
import { Pool, PoolClient, QueryResultRow } from "pg";
import { log } from "./logger";
import { getConfig } from "./config";
import { isRetryablePgError, retry } from "./retry";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL не задан");
  pool = new Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX ?? 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: process.env.WORKER_ID ?? "collector",
    statement_timeout: 60_000,
  });
  pool.on("error", (e) => log.error("pg pool error", { error: String(e) }));
  return pool;
}

/**
 * Ошибка, когда COMMIT завершился неизвестным результатом (потеря соединения).
 * Повторять транзакцию рискованно: запись могла примениться. Вызывающий код
 * обязан разрешить неопределённость, а не слепо ретраить.
 */
export class AmbiguousCommitError extends Error {
  constructor(public override readonly cause: unknown) {
    super("transaction COMMIT outcome is unknown (connection lost); manual verification required");
    this.name = "AmbiguousCommitError";
  }
}

function isCommitRelated(error: unknown): boolean {
  const message = String((error as Error | undefined)?.message ?? error);
  return /commit|connection (reset|lost|closed)|terminated|ECONNRESET|socket hang up/i.test(message);
}

async function withPgRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const cfg = getConfig();
  return retry(fn, {
    attempts: cfg.db.retryAttempts,
    baseDelayMs: cfg.db.retryBaseMs,
    maxDelayMs: cfg.db.retryMaxMs,
    shouldRetry: isRetryablePgError,
    onRetry: ({ attempt, delayMs, error }) => {
      log.warn("query retrying after transient error", {
        label, attempt, delay: delayMs, error: String(error instanceof Error ? error.message : error),
      });
    },
  });
}

/**
 * Одиночный SELECT/INSERT без обёртки транзакции. Намеренно single-attempt:
 * повтор многострочной записи без транзакции может задвоить эффект. Для
 * транзакционной работы используйте tx().
 */
export async function q<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const start = Date.now();
  try {
    const r = await getPool().query<T>(sql, params);
    const dur = Date.now() - start;
    if (dur > 1000) log.warn("slow query", { dur, sql: sql.slice(0, 120) });
    return r.rows;
  } catch (e) {
    log.error("query failed", { sql: sql.slice(0, 120), error: String(e) });
    throw e;
  }
}

export async function q1<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

export async function exec(sql: string, params: unknown[] = []): Promise<number> {
  const r = await getPool().query(sql, params);
  return r.rowCount ?? 0;
}

/**
 * Транзакция с retry. Повторяется только весь блок целиком при serialization/
 * deadlock/connection ошибках ДО COMMIT. Если COMMIT оборвался — выбрасывается
 * AmbiguousCommitError, и повтор не выполняется.
 */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withPgRetry(async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      try {
        await client.query("COMMIT");
      } catch (commitError) {
        if (isCommitRelated(commitError)) throw new AmbiguousCommitError(commitError);
        throw commitError;
      }
      return result;
    } catch (e) {
      if (e instanceof AmbiguousCommitError) throw e;
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }, "tx");
}

export async function closePool(): Promise<void> {
  const p = pool;
  pool = null;
  if (!p) return;
  try {
    await p.end();
  } catch (e) {
    log.warn("pool close failed", { error: String(e) });
  }
}
