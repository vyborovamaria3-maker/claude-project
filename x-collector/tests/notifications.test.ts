import test from "node:test";
import assert from "node:assert/strict";
import {
  notify, escapeHtml, PermanentNotificationError, RetryableNotificationError,
} from "../lib/trade/notifications";
import { getConfig, resetConfigCache, type AppConfig } from "../lib/trade/config";

function withChannels(patch: (cfg: AppConfig) => void): () => void {
  resetConfigCache();
  const cfg = getConfig();
  patch(cfg);
  return () => resetConfigCache();
}

test("escapeHtml escapes all five HTML entities", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("notify returns skipped when no channels are enabled", async () => {
  const restore = withChannels((cfg) => {
    cfg.notifications.telegram.enabled = false;
    cfg.notifications.webhook.enabled = false;
  });
  try {
    assert.equal(await notify({ title: "t", body: "b" }), "skipped");
  } finally {
    restore();
  }
});

test("telegram 4xx is permanent (no retry)", async () => {
  const restore = withChannels((cfg) => {
    cfg.notifications.telegram.enabled = true;
    cfg.notifications.telegram.botToken = "tok";
    cfg.notifications.telegram.chatId = "1";
    cfg.notifications.webhook.enabled = false;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
  try {
    await assert.rejects(notify({ title: "t", body: "b" }), (e: unknown) => e instanceof PermanentNotificationError);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("telegram 429 is retryable and carries retry_after", async () => {
  const restore = withChannels((cfg) => {
    cfg.notifications.telegram.enabled = true;
    cfg.notifications.telegram.botToken = "tok";
    cfg.notifications.telegram.chatId = "1";
    cfg.notifications.webhook.enabled = false;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ parameters: { retry_after: 7 } }),
    { status: 429, headers: { "content-type": "application/json" } },
  )) as typeof fetch;
  try {
    await assert.rejects(notify({ title: "t", body: "b" }), (e: unknown) => {
      return e instanceof RetryableNotificationError && e.retryAfterMs === 7000;
    });
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("partial success is acknowledged without retrying the failed channel", async () => {
  const restore = withChannels((cfg) => {
    cfg.notifications.telegram.enabled = true;
    cfg.notifications.telegram.botToken = "tok";
    cfg.notifications.telegram.chatId = "1";
    cfg.notifications.webhook.enabled = true;
    cfg.notifications.webhook.url = "https://hook.example";
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.telegram.org")) return new Response("ok", { status: 200 });
    return new Response("nope", { status: 500 });
  }) as typeof fetch;
  try {
    assert.equal(await notify({ title: "t", body: "b" }), "delivered");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});
