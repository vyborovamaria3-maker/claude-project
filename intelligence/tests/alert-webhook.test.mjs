import test from "node:test";
import assert from "node:assert/strict";
import {
  createAlertWebhookSink,
  parseAlertWebhookConfig,
} from "../scripts/alert-webhook.mjs";

const event = overrides => ({
  timestamp: "2026-10-31T12:00:00.000Z",
  kind: "alert",
  source: "x",
  code: "dead_letter_events_present",
  deadLetter: 2,
  oldestPendingAgeMs: 600000,
  maxAttempts: 5,
  ...overrides,
});
const config = overrides => ({
  url: "https://monitor.example.invalid/intelligence-alerts",
  token: null,
  timeoutMs: 1000,
  ...overrides,
});

test("webhook is disabled by default and rejects unsafe or incomplete configuration", () => {
  assert.equal(parseAlertWebhookConfig({}), null);
  assert.throws(
    () => parseAlertWebhookConfig({ INTELLIGENCE_ALERT_WEBHOOK_TOKEN: "secret" }),
    /token_requires_url/,
  );
  assert.throws(
    () => parseAlertWebhookConfig({ INTELLIGENCE_ALERT_WEBHOOK_URL: "http://monitor.invalid/hook" }),
    /must_be_https/,
  );
  assert.throws(
    () => parseAlertWebhookConfig({ INTELLIGENCE_ALERT_WEBHOOK_URL: "https://user:pass@monitor.invalid/hook" }),
    /must_be_https/,
  );
  assert.throws(
    () => parseAlertWebhookConfig({ INTELLIGENCE_ALERT_WEBHOOK_URL: "https://monitor.invalid/hook#fragment" }),
    /must_be_https/,
  );
  assert.throws(
    () => parseAlertWebhookConfig({
      INTELLIGENCE_ALERT_WEBHOOK_URL: "https://monitor.invalid/hook",
      INTELLIGENCE_ALERT_WEBHOOK_TIMEOUT_MS: "10000",
    }),
    /timeout/,
  );
  assert.throws(
    () => parseAlertWebhookConfig({
      INTELLIGENCE_ALERT_WEBHOOK_URL: "https://monitor.invalid/hook",
      INTELLIGENCE_ALERT_WEBHOOK_TOKEN: "bad\nheader",
    }),
    /token/,
  );
  assert.deepEqual(
    parseAlertWebhookConfig({
      INTELLIGENCE_ALERT_WEBHOOK_URL: "https://monitor.invalid/hook",
      INTELLIGENCE_ALERT_WEBHOOK_TOKEN: "  bearer-secret  ",
      INTELLIGENCE_ALERT_WEBHOOK_TIMEOUT_MS: "1500",
    }),
    {
      url: "https://monitor.invalid/hook",
      token: "bearer-secret",
      timeoutMs: 1500,
    },
  );
});

test("only allowlisted alert transitions are posted with minimal payload and bearer auth", async () => {
  const requests = [];
  const sink = createAlertWebhookSink(config({ token: "test-token" }), {
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 204 };
    },
  });

  assert.equal(sink.enqueue(event({
    payload: "private raw payload",
    dsn: "postgres://private",
    rawError: "secret error",
  })), true);
  assert.equal(sink.enqueue(event({ kind: "health" })), false);
  assert.equal(sink.enqueue(event({ source: "unknown" })), false);
  assert.equal(sink.enqueue(event({ code: "untrusted_code" })), false);

  const stats = await sink.flush();
  assert.deepEqual(stats, { delivered: 1, failed: 0, dropped: 0 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, config().url);
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].init.headers.authorization, "Bearer test-token");
  assert.equal(requests[0].init.headers["content-type"], "application/json");

  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual(body, {
    schema: "potapoff.intelligence.alert.v1",
    state: "active",
    source: "x",
    code: "dead_letter_events_present",
    observedAt: "2026-10-31T12:00:00.000Z",
    details: {
      oldestPendingAgeMs: 600000,
      deadLetter: 2,
      maxAttempts: 5,
    },
  });
  assert.equal(JSON.stringify(body).includes("private raw payload"), false);
  assert.equal(JSON.stringify(body).includes("postgres://private"), false);
  assert.equal(JSON.stringify(body).includes("secret error"), false);
});

test("retries one transient failure but does not retry permanent client errors", async () => {
  let transientCalls = 0;
  const transient = createAlertWebhookSink(config(), {
    retryDelayMs: 0,
    fetchImpl: async () => {
      transientCalls++;
      return transientCalls === 1
        ? { ok: false, status: 503 }
        : { ok: true, status: 200 };
    },
  });
  transient.enqueue(event({ kind: "alert_recovered" }));
  assert.deepEqual(await transient.flush(), { delivered: 1, failed: 0, dropped: 0 });
  assert.equal(transientCalls, 2);

  let permanentCalls = 0;
  const statuses = [];
  const permanent = createAlertWebhookSink(config(), {
    onStatus: value => statuses.push(value),
    fetchImpl: async () => {
      permanentCalls++;
      return { ok: false, status: 401 };
    },
  });
  permanent.enqueue(event());
  assert.deepEqual(await permanent.flush(), { delivered: 0, failed: 1, dropped: 0 });
  assert.equal(permanentCalls, 1);
  assert.deepEqual(statuses, [{
    kind: "alert_delivery",
    source: "x",
    code: "webhook_delivery_failed",
    attempts: 2,
  }]);
});

test("bounded queue drops excess alerts without blocking the caller", async () => {
  let resolveFirst;
  const statuses = [];
  let calls = 0;
  const sink = createAlertWebhookSink(config(), {
    maxQueue: 1,
    maxAttempts: 1,
    onStatus: value => statuses.push(value),
    fetchImpl: () => {
      calls++;
      if (calls === 1) return new Promise(resolve => { resolveFirst = resolve; });
      return Promise.resolve({ ok: true, status: 200 });
    },
  });

  assert.equal(sink.enqueue(event()), true);
  await Promise.resolve();
  assert.equal(typeof resolveFirst, "function");
  assert.equal(sink.enqueue(event({ code: "oldest_pending_age_exceeded" })), true);
  assert.equal(sink.enqueue(event({ code: "pending_retry_threshold_exceeded" })), false);
  assert.deepEqual(statuses, [{
    kind: "alert_delivery",
    source: "x",
    code: "webhook_queue_full",
  }]);

  resolveFirst({ ok: true, status: 200 });
  const stats = await sink.flush();
  assert.deepEqual(stats, { delivered: 2, failed: 0, dropped: 1 });
});
