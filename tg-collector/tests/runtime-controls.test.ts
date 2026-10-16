import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

test("runtime controls and proxy schema are installed", { skip: !process.env.DATABASE_URL }, async () => {
  const { pool } = await import("../src/db.js");
  const init = await readFile(new URL("../sql/001_init.sql", import.meta.url), "utf8");
  const controls = await readFile(new URL("../sql/009_runtime_controls_proxy.sql", import.meta.url), "utf8");
  const schema = "tg_runtime_" + randomUUID().replaceAll("-", "").slice(0, 16);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(init);
    await client.query(controls);

    const runtime = await client.query<{collection_enabled: boolean}>(
      "SELECT collection_enabled FROM tg_runtime WHERE id=1"
    );
    assert.equal(runtime.rows[0]?.collection_enabled, true);
    await client.query("UPDATE tg_runtime SET collection_enabled=FALSE WHERE id=1");
    const stopped = await client.query<{collection_enabled: boolean}>("SELECT collection_enabled FROM tg_runtime WHERE id=1");
    assert.equal(stopped.rows[0]?.collection_enabled, false);

    const proxy = await client.query<{column_name: string}>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='tg_proxy_config' ORDER BY ordinal_position",
      [schema]
    );
    assert.deepEqual(proxy.rows.map(row => row.column_name), [
      "id", "proxy_type", "host", "port", "username_enc", "password_enc", "secret_enc", "enabled", "updated_at",
    ]);
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});
