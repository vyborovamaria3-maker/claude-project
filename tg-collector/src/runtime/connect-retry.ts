import { setTimeout as sleep } from "node:timers/promises";
import { classifyTelegramError } from "../queue/retry.js";

function transientTransport(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNABORTED|EPIPE)\b|(?:socket|network|connection) (?:closed|lost|timed out|reset)/i.test(message);
}

/** Retry only transient startup transport failures; never rotate sessions or evade Telegram restrictions. */
export async function connectWithRetry<T>(
  connect: () => Promise<T>,
  options: { attempts?: number; pause?: (ms: number) => Promise<unknown>; random?: () => number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const pause = options.pause ?? sleep;
  const random = options.random ?? Math.random;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) throw new Error("Invalid retry attempts");
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await connect();
    } catch (error) {
      const decision = classifyTelegramError(error, attempt);
      if (decision.action !== "delay" || decision.global || !transientTransport(error) || attempt + 1 >= attempts)
        throw error;
      const delayMs = Math.min(15_000, 1500 * (2 ** attempt)) +
        Math.floor(Math.max(0,Math.min(.999999,random())) * 1000);
      console.warn("TG transport connection failed; retrying after transient failure", {attempt:attempt+1});
      await pause(delayMs);
    }
  }
  throw new Error("Telegram connection retry exhausted");
}
