import { classifyError, RateLimitError } from "./errors.js";

export type RetryOptions = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
};

export function exponentialBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  if (!Number.isInteger(attempt) || attempt < 1 || baseDelayMs < 0 || maxDelayMs < baseDelayMs) {
    throw new RangeError("Invalid retry delay inputs");
  }
  return Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.min(attempt - 1, 30)));
}

export function jitter(delayMs: number, ratio: number, random = Math.random): number {
  if (!Number.isFinite(delayMs) || delayMs < 0 || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new RangeError("Invalid jitter options");
  }
  return Math.round(delayMs * (1 - ratio * random()));
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be positive");
  }
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("Aborted");
    try { return await fn(attempt); }
    catch (error) {
      const category = classifyError(error);
      if (category === "permanent" || category === "auth" || category === "unknown" || attempt === opts.maxAttempts) {
        throw error;
      }
      const exponential = exponentialBackoff(attempt, opts.baseDelayMs, opts.maxDelayMs);
      const requested = error instanceof RateLimitError ? error.retryAfterMs ?? 0 : 0;
      const delay = Math.max(requested, jitter(exponential, opts.jitterRatio ?? 0.15));
      opts.onRetry?.(attempt, error, delay);
      await sleep(delay, opts.signal);
    }
  }
  throw new Error("unreachable");
}
