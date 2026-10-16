import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:1/unused";
process.env.TG_PROXY_ENCRYPTION_KEY = "fixture-proxy-key";
const { pool } = await import("../src/db.js");
const { saveProxy, loadProxy } = await import("../src/runtime/proxy.js");

test("SOCKS4/SOCKS5 select SOCKS transport; MTProto alone selects MTProxy", async () => {
  const originalQuery = pool.query;
  let stored: Record<string, unknown> | undefined;
  pool.query = (async (sql: string, params?: unknown[]) => {
    if (sql.startsWith("INSERT INTO tg_proxy_config")) {
      stored = { enabled: true, proxy_type: params![0], host: params![1], port: params![2],
        username_enc: params![3], password_enc: params![4], secret_enc: params![5] };
      return { rows: [] };
    }
    return { rows: stored ? [stored] : [] };
  }) as typeof pool.query;
  try {
    for (const proxyType of ["socks4", "socks5", "mtproxy"] as const) {
      await saveProxy({ proxyType, host: "127.0.0.1", port: 1080,
        ...(proxyType === "mtproxy" ? { secret: "00".repeat(16) }
          : { username: "fixture-user", password: " fixture-password " }) }, false);
      const proxy = await loadProxy();
      assert.ok(proxy);
      const client = new TelegramClient(new StringSession(""), 1, "fixture-api-hash", { proxy });
      const connection = (client as unknown as { _connection: { name: string } })._connection.name;
      if (proxyType === "mtproxy") assert.equal(connection, "ConnectionTCPMTProxyAbridged");
      else {
        assert.equal("MTProxy" in proxy, false);
        assert.notEqual(connection, "ConnectionTCPMTProxyAbridged");
        assert.equal("socksType" in proxy && proxy.socksType, proxyType === "socks4" ? 4 : 5);
        assert.equal("password" in proxy && proxy.password, " fixture-password ");
        assert.notEqual(stored?.password_enc, " fixture-password ");
      }
    }
    await saveProxy({ proxyType: "socks5", host: "first.example", port: 1080,
      username: "fixture-user", password: "fixture-password" }, false);
    await saveProxy({ proxyType: "socks5", host: "first.example", port: 1080 });
    assert.ok(stored?.password_enc, "same endpoint preserves credentials");
    await saveProxy({ proxyType: "socks5", host: "second.example", port: 1080 });
    assert.equal(stored?.password_enc, null, "new endpoint must not receive old credentials");
  } finally { pool.query = originalQuery; await pool.end(); }
});
