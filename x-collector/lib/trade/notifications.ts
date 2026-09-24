import { getConfig } from "./config";
import { log } from "./logger";

const DELIVERY_TIMEOUT_MS = 15_000;

export interface Notification { title: string; body: string; meta?: Record<string, unknown>; }

export async function notify(n: Notification) {
  const cfg = getConfig();
  const jobs: Promise<void>[] = [];
  if (cfg.notifications.telegram.enabled) jobs.push(sendTelegram(n, cfg.notifications.telegram));
  if (cfg.notifications.webhook.enabled) jobs.push(sendWebhook(n, cfg.notifications.webhook.url));
  if (jobs.length === 0) throw new Error("notification delivery failed: no channels are enabled");
  const results = await Promise.allSettled(jobs);
  const successes = results.filter((result) => result.status === "fulfilled").length;
  const failures = results.flatMap((result) => result.status === "rejected" ? [String(result.reason)] : []);
  if (successes === 0) {
    throw new Error(`notification delivery failed (${failures.length}/${results.length}): ${failures.join("; ")}`);
  }
  if (failures.length) {
    log.warn("partial notification delivery failure; at least one channel succeeded", { failures });
  }
}

async function sendTelegram(n: Notification, cfg: { botToken: string; chatId: string }) {
  try {
    const text = `*${n.title}*\n${n.body}`;
    const r = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`telegram ${r.status}`);
  } catch (e) { log.warn("telegram notification failed", { error: String(e) }); throw e; }
}

async function sendWebhook(n: Notification, url: string) {
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...n, ts: Date.now() }),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`webhook ${r.status}`);
  } catch (e) { log.warn("webhook notification failed", { error: String(e) }); throw e; }
}