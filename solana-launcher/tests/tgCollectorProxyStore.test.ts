import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { readTgProxy, writeTgProxy } from "../lib/tgCollectorProxyStore.ts";

test("TG proxy credentials are encrypted and never returned by status", async () => {
  process.env.TG_PROXY_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  let stored: unknown[] = [];
  const fakePool = {
    async query(sql: string, params?: unknown[]) {
      if (sql.startsWith("SELECT username_enc")) return { rows: [] };
      if (sql.startsWith("INSERT INTO tg_proxy_config")) {
        stored = params ?? [];
        return { rows: [] };
      }
      if (sql.startsWith("SELECT enabled,proxy_type")) {
        return {
          rows: [{
            enabled: true, proxy_type: "socks5", host: "127.0.0.1", port: 1080,
            username_enc: stored[3] ?? null, password_enc: stored[4] ?? null, secret_enc: null,
            updated_at: new Date().toISOString(),
          }],
        };
      }
      throw new Error("Unexpected SQL in fake pool");
    },
  } as unknown as Pool;

  await writeTgProxy(fakePool, {
    proxyType: "socks5",
    host: "127.0.0.1",
    port: 1080,
    username: "collector-user",
    password: "collector-password",
  });

  assert.equal(stored[3] === "collector-user", false);
  assert.equal(stored[4] === "collector-password", false);

  const status = await readTgProxy(fakePool);
  assert.equal(status.usernameConfigured, true);
  assert.equal(status.passwordConfigured, true);
  assert.equal("username" in status, false);
  assert.equal("password" in status, false);
});


test("TG proxy preserves credentials only for the same endpoint", async () => {
  process.env.TG_PROXY_ENCRYPTION_KEY = "fixture-proxy-key";
  let stored: unknown[] = [];
  const fakePool = {
    async query(sql: string, params?: unknown[]) {
      if (sql.startsWith("SELECT username_enc")) return { rows: stored.length ? [{
        proxy_type: stored[0], host: stored[1], port: stored[2],
        username_enc: stored[3], password_enc: stored[4], secret_enc: stored[5],
      }] : [] };
      stored = params ?? [];
      return { rows: [] };
    },
  } as unknown as Pool;
  await writeTgProxy(fakePool, { proxyType: "socks5", host: "first.example", port: 1080,
    username: "fixture-user", password: " fixture-password " });
  await writeTgProxy(fakePool, { proxyType: "socks5", host: "first.example", port: 1080 });
  assert.ok(stored[3]);
  assert.ok(stored[4]);
  await writeTgProxy(fakePool, { proxyType: "socks5", host: "second.example", port: 1080 });
  assert.equal(stored[3], null);
  assert.equal(stored[4], null);
});
