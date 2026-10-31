const ALERT_KINDS = new Set(["alert", "alert_recovered"]);
const ALERT_SOURCES = new Set(["x", "tg", "blockchain"]);
const ALERT_CODES = new Set([
  "dead_letter_events_present",
  "oldest_pending_age_exceeded",
  "pending_retry_threshold_exceeded",
  "health_probe_failed",
]);

const DEFAULT_TIMEOUT_MS = 2000;
const MAX_TIMEOUT_MS = 5000;
const DEFAULT_QUEUE_LIMIT = 16;
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;

export function parseAlertWebhookConfig(env = process.env) {
  const rawUrl = typeof env.INTELLIGENCE_ALERT_WEBHOOK_URL === "string"
    ? env.INTELLIGENCE_ALERT_WEBHOOK_URL.trim()
    : "";
  const token = typeof env.INTELLIGENCE_ALERT_WEBHOOK_TOKEN === "string"
    ? env.INTELLIGENCE_ALERT_WEBHOOK_TOKEN.trim()
    : "";

  if (!rawUrl) {
    if (token) throw new Error("alert_webhook_token_requires_url");
    return null;
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid_alert_webhook_url");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
    throw new Error("alert_webhook_url_must_be_https_without_credentials_or_fragment");
  }
  if (token.length > 4096 || /[\\r\\n]/.test(token)) {
    throw new Error("invalid_alert_webhook_token");
  }

  const rawTimeout = env.INTELLIGENCE_ALERT_WEBHOOK_TIMEOUT_MS;
  const timeoutMs = rawTimeout === undefined || rawTimeout === ""
    ? DEFAULT_TIMEOUT_MS
    : Number(rawTimeout);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("invalid_alert_webhook_timeout");
  }

  return Object.freeze({
    url: url.toString(),
    token: token || null,
    timeoutMs,
  });
}

function makePayload(event) {
  if (!event || !ALERT_KINDS.has(event.kind) ||
      !ALERT_SOURCES.has(event.source) || !ALERT_CODES.has(event.code)) {
    return null;
  }

  const parsedAt = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
  const observedAt = Number.isFinite(parsedAt)
    ? new Date(parsedAt).toISOString()
    : new Date().toISOString();
  const details = {};
  for (const key of ["oldestPendingAgeMs", "deadLetter", "maxAttempts"]) {
    const value = event[key];
    if (Number.isSafeInteger(value) && value >= 0) details[key] = value;
  }

  return {
    schema: "potapoff.intelligence.alert.v1",
    state: event.kind === "alert" ? "active" : "recovered",
    source: event.source,
    code: event.code,
    observedAt,
    details,
  };
}

/**
 * Optional, best-effort alert delivery. The bounded in-memory queue never
 * blocks source delivery; no event payloads, DSNs, URLs or raw errors are sent.
 * The receiver is responsible for durable alert history.
 */
export function createAlertWebhookSink(config, {
  fetchImpl = globalThis.fetch,
  onStatus = () => {},
  maxQueue = DEFAULT_QUEUE_LIMIT,
  maxAttempts = DEFAULT_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
  let target;
  try { target = new URL(config?.url); } catch {}
  if (!config || !target || target.protocol !== "https:" || !target.hostname ||
      target.username || target.password || target.hash ||
      !Number.isSafeInteger(config.timeoutMs) ||
      config.timeoutMs < 250 || config.timeoutMs > MAX_TIMEOUT_MS ||
      (config.token !== null && (typeof config.token !== "string" ||
        config.token.length > 4096 || /[\\r\\n]/.test(config.token))) ||
      typeof fetchImpl !== "function" || typeof onStatus !== "function" ||
      !Number.isSafeInteger(maxQueue) || maxQueue < 1 || maxQueue > 64 ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 2 ||
      !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 1000) {
    throw new TypeError("invalid alert webhook sink options");
  }

  const queue = [];
  let draining = false;
  let closed = false;
  let delivered = 0;
  let failed = 0;
  let dropped = 0;

  const reportStatus = event => {
    try { onStatus(event); } catch {}
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function deliver(item) {
    const headers = { "content-type": "application/json" };
    if (config.token) headers.authorization = "Bearer " + config.token;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      let retry = false;
      try {
        const response = await fetchImpl(config.url, {
          method: "POST",
          headers,
          body: JSON.stringify(item.payload),
          redirect: "error",
          signal: controller.signal,
        });
        if (response?.ok === true) return true;
        const status = Number(response?.status);
        retry = status === 429 || status >= 500;
      } catch {
        retry = true;
      } finally {
        clearTimeout(timer);
      }

      if (!retry || attempt === maxAttempts) return false;
      await pause(retryDelayMs);
    }
    return false;
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        if (await deliver(item)) {
          delivered++;
        } else {
          failed++;
          reportStatus({
            kind: "alert_delivery",
            source: item.event.source,
            code: "webhook_delivery_failed",
            attempts: maxAttempts,
          });
        }
      }
    } finally {
      draining = false;
    }
  }

  function enqueue(event) {
    const payload = makePayload(event);
    if (!payload) return false;
    if (closed || queue.length >= maxQueue) {
      dropped++;
      reportStatus({
        kind: "alert_delivery",
        source: event.source,
        code: closed ? "webhook_sink_closed" : "webhook_queue_full",
      });
      return false;
    }
    queue.push({ event, payload });
    if (!draining) void drain().catch(() => {});
    return true;
  }

  async function flush(timeoutMs = 5000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 10_000) {
      throw new RangeError("invalid alert webhook flush timeout");
    }
    const deadline = Date.now() + timeoutMs;
    while (draining || queue.length) {
      if (Date.now() >= deadline) {
        const abandoned = queue.length;
        queue.length = 0;
        dropped += abandoned;
        closed = true;
        reportStatus({
          kind: "alert_delivery",
          code: "webhook_flush_timeout",
          dropped: abandoned,
        });
        return { delivered, failed, dropped };
      }
      await pause(20);
    }
    closed = true;
    return { delivered, failed, dropped };
  }

  return {
    enqueue,
    flush,
    stats: () => ({ delivered, failed, dropped, queued: queue.length, draining }),
  };
}
