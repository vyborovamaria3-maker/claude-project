import { getPool } from "./pg";
import { log } from "./logger";

/** Стабильный 32-битный ключ (FNV-1a) для pg_advisory_lock по имени операции. */
export function advisoryKey(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

export interface LockHandle {
  acquired: true;
  release(): Promise<void>;
}

export type LockResult<T> = { acquired: true; result: T } | { acquired: false };

/**
 * Выполняет fn под сессионным advisory lock'ом. Если lock занят другим
 * процессом, fn не выполняется и возвращается { acquired: false }.
 * Все запросы внутри fn идут через обычный пул — lock удерживается отдельной
 * сессией ровно на время выполнения fn.
 */
export async function withAdvisoryLock<T>(name: string, fn: () => Promise<T>): Promise<LockResult<T>> {
  const client = await getPool().connect();
  const key = advisoryKey(name);
  let acquired = false;
  try {
    const r = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock($1) AS locked`, [key]);
    acquired = r.rows[0]?.locked === true;
    if (!acquired) return { acquired: false };
    const result = await fn();
    return { acquired: true, result };
  } finally {
    if (acquired) {
      await client.query(`SELECT pg_advisory_unlock($1)`, [key])
        .catch((e) => log.warn("advisory unlock failed", { lock: name, error: String(e) }));
    }
    client.release();
  }
}

/** Блокировка, которую нельзя пропустить: бросает исключение, если lock занят. */
export async function withAdvisoryLockOrThrow<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const r = await withAdvisoryLock(name, fn);
  if (!r.acquired) throw new Error(`operation already running: ${name}`);
  return r.result;
}
