import "dotenv/config";
import { Pool, PoolClient, QueryResultRow } from "pg";
import { log } from "./logger";
import { getConfig } from "./config";
import { isRetryablePgError, pgErrorCode, retry } from "./retry";

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

/**
 * A server-side serialization/deadlock error at COMMIT guarantees abort;
 * all connection failures and errors without a PostgreSQL SQLSTATE leave
 * the COMMIT outcome uncertain. Never replay such a transaction.
 */
export function isAmbiguousPgCommit(error: unknown): boolean {
  const code = pgErrorCode(error);
  if (code === "40001" || code === "40P01") return false;
  if (!code) return true;
  return isRetryablePgError(error);
}

async function withPgRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const cfg = getConfig();
  return retry(fn, {
    attempts: cfg.db.retryAttempts,
    baseDelayMs: cfg.db.retryBaseMs,
    maxDelayMs: cfg.db.retryMaxMs,
    // The AmbiguousCommitError message mentions a lost connection, but the
    // transaction might already be committed: never replay that wrapper.
    shouldRetry: (error) => !(error instanceof AmbiguousCommitError) && isRetryablePgError(error),
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

/** A single shared DB probe avoids piling up abandoned pool queries during outages. */
let healthProbe: Promise<void> | null = null;

/**
 * Bound the HTTP response even while a pool connection is unavailable.
 * Promise.race does not cancel a pg query: reuse one in-flight probe rather
 * than starting another on every dashboard/worker health request.
 */
export async function checkDatabase(timeoutMs = 3000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error("Invalid database health timeout");
  if (!healthProbe) {
    const started: Promise<void> = getPool().query("SELECT 1").then(() => {});
    healthProbe = started;
    void started.then(
      () => { if (healthProbe === started) healthProbe = null; },
      () => { if (healthProbe === started) healthProbe = null; },
    );
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      healthProbe,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("database health timeout")), timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * Транзакция с retry. Повторяется только весь блок целиком при serialization/
 * deadlock/connection ошибках ДО COMMIT. Если COMMIT оборвался — выбрасывается
 * AmbiguousCommitError, и повтор не выполняется.
 */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withPgRetry(async () => {
    const client = await getPool().connect();
    let discardClient = false;
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      try {
        await client.query("COMMIT");
      } catch (commitError) {
        if (isAmbiguousPgCommit(commitError)) {
          discardClient = true;
          throw new AmbiguousCommitError(commitError);
        }
        throw commitError;
      }
      return result;
    } catch (e) {
      if (e instanceof AmbiguousCommitError) throw e;
      if (isRetryablePgError(e)) discardClient = true;
      await client.query("ROLLBACK").catch(() => { discardClient = true; });
      throw e;
    } finally {
      // Broken/uncertain connections must never go back to the pool.
      client.release(discardClient);
    }
  }, "tx");
}

export async function closePool(): Promise<void> {
  const p = pool;
  pool = null;
  healthProbe = null;
  if (!p) return;
  try {
    await p.end();
  } catch (e) {
    log.warn("pool close failed", { error: String(e) });
  }
}
