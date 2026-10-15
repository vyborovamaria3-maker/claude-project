import { setTimeout as delay } from "node:timers/promises";
import { backoffDelay, isRetryablePgError } from "../../../lib/trade/retry";

export interface DatabaseRecoveryOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onRetry?: (details: { attempt: number; delayMs: number; error: unknown }) => void;
}

const defaultSleep = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  await delay(milliseconds, undefined, { signal });
};

/**
 * Keeps a worker in STARTING/DEGRADED until the database can accept a write.
 * Never retries non-transient SQL failures (e.g. missing migrations), and
 * never replays an ambiguous transaction: the probe must be idempotent.
 */
export async function waitForDatabaseRecovery(
  probe: () => Promise<void>,
  signal: AbortSignal,
  options: DatabaseRecoveryOptions = {},
): Promise<void> {
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 1 ||
      !Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new Error("Invalid database recovery delays");
  }
  const sleep = options.sleep ?? defaultSleep;
  let failures = 0;
  while (true) {
    signal.throwIfAborted();
    try {
      await probe();
      signal.throwIfAborted();
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (!isRetryablePgError(error)) throw error;
      failures++;
      const delayMs = backoffDelay(failures, baseDelayMs, maxDelayMs, options.random);
      options.onRetry?.({ attempt: failures, delayMs, error });
      await sleep(delayMs, signal);
    }
  }
}
