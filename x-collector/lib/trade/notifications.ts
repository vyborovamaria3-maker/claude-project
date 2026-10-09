import { getConfig } from "./config";
import { log } from "./logger";

const DELIVERY_TIMEOUT_MS = 15_000;

export interface Notification { title: string; body: string; meta?: Record<string, unknown>; }

export class PermanentNotificationError extends Error {
  constructor(message: string, public readonly channel?: string, public readonly statusCode?: number) {
    super(message);
    this.name = "PermanentNotificationError";
  }
}

export class RetryableNotificationError extends Error {
  constructor(message: string, public readonly retryAfterMs?: number, public readonly channel?: string) {
    super(message);
    this.name = "RetryableNotificationError";
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

function getRetryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function telegramSend(n: Notification, cfg: { botToken: string; chatId: string }): Promise<void> {
  const title = escapeHtml(n.title);
  const body = escapeHtml(n.body);
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text: `<b>${title}</b>\n${body}`, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (error) {
    throw new RetryableNotificationError(`telegram transport error: ${String(error)}`, undefined, "telegram");
  }
  if (response.ok) return;
  if (response.status === 429 || response.status === 408 || response.status >= 500) {
    let retryAfterMs = getRetryAfterMs(response);
    if (response.status === 429) {
      try {
        const payload = await response.clone().json() as { parameters?: { retry_after?: number } };
        if (Number.isFinite(payload.parameters?.retry_after)) {
          retryAfterMs = (payload.parameters!.retry_after as number) * 1000;
        }
      } catch { /* Retry-After header remains the fallback. */ }
    }
    throw new RetryableNotificationError(`telegram HTTP ${response.status}`, retryAfterMs, "telegram");
  }
  throw new PermanentNotificationError(`telegram HTTP ${response.status}`, "telegram", response.status);
}

async function webhookSend(n: Notification, url: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...n, ts: Date.now() }),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (error) {
    throw new RetryableNotificationError(`webhook transport error: ${String(error)}`, undefined, "webhook");
  }
  if (response.ok) return;
  if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
    throw new RetryableNotificationError(`webhook HTTP ${response.status}`, getRetryAfterMs(response), "webhook");
  }
  throw new PermanentNotificationError(`webhook HTTP ${response.status}`, "webhook", response.status);
}

export async function notify(n: Notification): Promise<"delivered" | "skipped"> {
  const cfg = getConfig();
  const jobs: Array<{ channel: string; promise: Promise<void> }> = [];
  if (cfg.notifications.telegram.enabled) {
    jobs.push({ channel: "telegram", promise: telegramSend(n, cfg.notifications.telegram) });
  }
  if (cfg.notifications.webhook.enabled) {
    jobs.push({ channel: "webhook", promise: webhookSend(n, cfg.notifications.webhook.url) });
  }
  if (!jobs.length) {
    log.info("notification skipped — no channels enabled", { title: n.title });
    return "skipped";
  }

  const results = await Promise.allSettled(jobs.map((job) => job.promise));
  const successes = results.filter((result) => result.status === "fulfilled").length;
  const failures = results.flatMap((result, index) => result.status === "rejected"
    ? [{ channel: jobs[index].channel, error: result.reason }]
    : []);

  // Одной успешной доставки достаточно. Повтор при частичном успехе продублировал
  // бы сообщение в канале, который уже его получил (outbox — at-least-once).
  if (successes > 0) {
    if (failures.length) {
      log.warn("partial notification delivery failure; another channel succeeded", {
        failures: failures.map((item) => ({ channel: item.channel, error: String(item.error) })),
      });
    }
    return "delivered";
  }

  if (failures.length && failures.every((item) => item.error instanceof PermanentNotificationError)) {
    throw new PermanentNotificationError(
      failures.map((item) => `${item.channel}: ${String(item.error)}`).join("; ")
    );
  }
  const retryAfterMs = Math.max(0, ...failures.map((item) =>
    item.error instanceof RetryableNotificationError ? item.error.retryAfterMs ?? 0 : 0
  ));
  throw new RetryableNotificationError(
    `notification delivery failed (${failures.length}/${jobs.length} channels): ` +
      failures.map((item) => `${item.channel}: ${String(item.error)}`).join("; "),
    retryAfterMs || undefined,
  );
}

export function notificationRetryDelayMs(attempts: number, error: unknown): number {
  const backoff = Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8));
  const requested = error instanceof RetryableNotificationError ? error.retryAfterMs : undefined;
  return requested !== undefined && Number.isFinite(requested)
    ? Math.max(backoff, requested) : backoff;
}
