import "dotenv/config";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { TelegramClient } from "telegram";

test("PostgreSQL: Stop preserves page checkpoint; rebuild excludes soft deletes; active counts survive purge", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const { pool, migrate } = await import("../../src/db.js");
  const { claim } = await import("../../src/queue/jobs.js");
  const { processJob } = await import("../../src/engines/channel.js");
  const { markMessageDeleted } = await import("../../src/persistence/messages.js");
  await migrate();
  await migrate(); // additive upgrade remains repeatable
  const source = await pool.query<{id: string}>(
    "INSERT INTO tg_sources(identifier) VALUES($1) RETURNING id::text",
    ["runtime_" + randomUUID().replaceAll("-", "").slice(0, 18)]);
  const id = source.rows[0].id;
  try {
    await pool.query("INSERT INTO tg_jobs(source_id) VALUES($1)", [id]);
    await pool.query("UPDATE tg_runtime SET collection_enabled=FALSE WHERE id=1");
    assert.equal(await claim(), undefined);
    await pool.query("UPDATE tg_runtime SET collection_enabled=TRUE WHERE id=1");
    const job = await claim();
    assert.ok(job);
    assert.equal(job.source_id, id);
    let calls = 0;
    const client = {
      async getEntity() { return { className: "Channel", id: 123, title: "Fixture" }; },
      async getMessages() {
        calls++;
        if (calls === 1) return [{ id: 1000 }];
        assert.equal(calls, 2, "Stop must prevent the next Telegram page request");
        await pool.query("UPDATE tg_runtime SET collection_enabled=FALSE WHERE id=1");
        return Array.from({ length: 100 }, (_, i) => ({ id: 1000-i,
          message: "@fixture_handle", date: 1792065600 }));
      },
    } as unknown as TelegramClient;
    await processJob(client, job, () => false);
    assert.equal(calls, 2);
    const checkpoint = await pool.query("SELECT state,cursor_before_id,scanned_count FROM tg_jobs WHERE source_id=$1", [id]);
    assert.equal(checkpoint.rows[0].state, "pending");
    assert.equal(checkpoint.rows[0].cursor_before_id, "901");
    assert.equal(checkpoint.rows[0].scanned_count, 100);
    assert.equal(await claim(), undefined);

    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      assert.equal(await markMessageDeleted(tx, id, 1000), true);
      await tx.query("COMMIT");
    } finally { tx.release(); }
    // Simulate a legacy counter inconsistency and verify the additive repair.
    await pool.query("UPDATE tg_source_message_counters SET message_count=100 WHERE source_id=$1", [id]);
    await pool.query("UPDATE tg_runtime SET active_counters_initialized=FALSE WHERE id=1");
    await migrate();
    execFileSync(process.execPath, ["--import", "tsx", "src/analytics/refresh.ts"], { cwd: process.cwd(), stdio: "pipe" });
    const edges = await pool.query("SELECT evidence_count,message_count FROM tg_graph_daily_edges WHERE source_id=$1", [id]);
    assert.equal(edges.rows[0].evidence_count, 99);
    assert.equal(edges.rows[0].message_count, 99);
    const metrics = await pool.query("SELECT posts_count FROM tg_source_daily_metrics WHERE source_id=$1", [id]);
    assert.equal(metrics.rows[0].posts_count, 99);
    await pool.query("DELETE FROM tg_messages WHERE source_id=$1 AND message_id=1000", [id]);
    const count = await pool.query("SELECT message_count FROM tg_source_message_counters WHERE source_id=$1", [id]);
    assert.equal(Number(count.rows[0].message_count), 99);
  } finally {
    await pool.query("DELETE FROM tg_sources WHERE id=$1", [id]);
    await pool.query("UPDATE tg_runtime SET collection_enabled=TRUE WHERE id=1");
    await pool.end();
  }
});
