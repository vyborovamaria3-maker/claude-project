import "dotenv/config";
import { Pool, PoolClient, QueryResultRow } from "pg";
import { log } from "./logger";

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

export async function q<T extends QueryResultRow = any>(sql: string, params: any[] = []): Promise<T[]> {
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

export async function q1<T extends QueryResultRow = any>(sql: string, params: any[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

export async function exec(sql: string, params: any[] = []): Promise<number> {
  const r = await getPool().query(sql, params);
  return r.rowCount ?? 0;
}

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
}
