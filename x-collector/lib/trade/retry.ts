/**
 * Общий retry-примитив с jittered exponential backoff.
 *
 * Повторяются только ошибки, которые классифицирует `shouldRetry`. Это делает
 * поведение явным: вызывающий код решает, какие ошибки безопасно повторить
 * (например, serialization/deadlock), а какие — постоянные (например, 4xx/validation).
 */

export interface RetryOptions {
  /** Максимальное число попыток, включая первую. */
  attempts: number;
  /** Базовый интервал backoff в миллисекундах. */
  baseDelayMs: number;
  /** Верхняя граница интервала в миллисекундах. */
  maxDelayMs: number;
  /** Возвращает true, если ошибку безопасно повторить. */
  shouldRetry: (error: unknown) => boolean;
  /** Источник случайности (для тестов); по умолчанию Math.random. */
  random?: () => number;
  /** Функция ожидания (для тестов); по умолчанию setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Колбэк для логирования/метрик перед повтором. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Вычисляет задержку перед следующей попыткой.
 * Формула: min(base * 2^(attempt-1), max) с full jitter в диапазоне
 * [delay/2, delay]. Для attempt=1 задержка = base/2.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 20);
  const raw = Math.min(baseDelayMs * 2 ** exponent, maxDelayMs);
  const half = raw / 2;
  return Math.round(half + random() * half);
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    attempts, baseDelayMs, maxDelayMs, shouldRetry,
    random = Math.random,
    sleep = defaultSleep,
    onRetry,
  } = options;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("retry: attempts must be a positive integer");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error)) throw error;
      const delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs, random);
      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
  // Недостижимо: цикл либо возвращает значение, либо бросает.
  throw lastError;
}

/** Классифицирует ошибки PostgreSQL, которые безопасно повторить. */
const RETRYABLE_PG_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08P01", // protocol_violation
  "57P01", // admin_shutdown
  "57P02", // cannot_connect_now
  "57P03", // crash_shutdown
  "57P04", // database_is_shutting_down
]);

export function pgErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function isRetryablePgError(error: unknown): boolean {
  const code = pgErrorCode(error);
  if (code && RETRYABLE_PG_CODES.has(code)) return true;
  const message = String((error as Error | undefined)?.message ?? error);
  return /terminated|connection (reset|lost|closed)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up/i
    .test(message);
}
