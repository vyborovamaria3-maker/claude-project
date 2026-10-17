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
          message: "@fixture_handle", date: 1792065600,
          editDate: i === 0 ? 1792065610 : undefined,
          replyToMsgId: i === 0 ? 999 : undefined }));
      },
    } as unknown as TelegramClient;
    await processJob(client, job, () => false);
    assert.equal(calls, 2);
    const checkpoint = await pool.query("SELECT state,cursor_before_id,scanned_count FROM tg_jobs WHERE source_id=$1", [id]);
    assert.equal(checkpoint.rows[0].state, "pending");
    assert.equal(checkpoint.rows[0].cursor_before_id, "901");
    assert.equal(checkpoint.rows[0].scanned_count, 100);
    const messageMeta = await pool.query<{edited_at: Date | null; reply_to_message_id: string | null}>(
      "SELECT edited_at,reply_to_message_id::text FROM tg_messages WHERE source_id=$1 AND message_id=1000", [id]);
    assert.ok(messageMeta.rows[0].edited_at, "Telegram edit_date must be stored");
    assert.equal(messageMeta.rows[0].reply_to_message_id, "999");
    const thread = await pool.query("SELECT reply_to_message_id FROM tg_message_threads WHERE source_id=$1 AND message_id=1000", [id]);
    assert.equal(Number(thread.rows[0].reply_to_message_id), 999);
    const ledger = await pool.query<{name: string; checksum: string}>(
      "SELECT name,checksum FROM schema_migrations WHERE name=ANY($1::text[])",
      [["011_token_intelligence.sql","012_threads_narratives.sql","013_signal_dedup.sql","014_risk_assessment.sql"]]);
    assert.equal(ledger.rows.length, 4);
    assert.ok(ledger.rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum.trim())));
    assert.equal(await claim(), undefined);

    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      assert.equal(await markMessageDeleted(tx, id, 1000), true);
      await tx.query("COMMIT");
      const orphaned = await pool.query<{all_orphaned: boolean}>(
        "SELECT bool_and(orphaned) AS all_orphaned FROM tg_message_links WHERE source_id=$1 AND message_id=1000", [id]);
      assert.equal(orphaned.rows[0].all_orphaned, true, "soft delete must preserve links as orphaned evidence");
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
    const consistency = await pool.query<{mismatches: number}>(`
      WITH expected AS (
        SELECT l.source_id,(m.posted_at AT TIME ZONE 'UTC')::date AS day,l.kind,l.target_kind,l.target_key,
          count(*)::integer AS evidence_count,count(DISTINCT l.message_id)::integer AS message_count
        FROM tg_message_links l JOIN tg_messages m USING(source_id,message_id)
        WHERE l.source_id=$1 AND m.deleted_at IS NULL
        GROUP BY l.source_id,(m.posted_at AT TIME ZONE 'UTC')::date,l.kind,l.target_kind,l.target_key
      )
      SELECT count(*)::integer AS mismatches FROM (
        SELECT 1 FROM expected e FULL OUTER JOIN tg_graph_daily_edges g
          ON g.source_id=e.source_id AND g.day=e.day AND g.kind=e.kind
          AND g.target_kind=e.target_kind AND g.target_key=e.target_key
        WHERE e.evidence_count IS DISTINCT FROM g.evidence_count
          OR e.message_count IS DISTINCT FROM g.message_count
      ) mismatched
    `, [id]);
    assert.equal(consistency.rows[0].mismatches, 0, "daily graph rollups must match canonical evidence");
    const invalidSamples = await pool.query<{count: number}>(`
      SELECT count(*)::integer AS count FROM tg_graph_daily_edges g
      LEFT JOIN tg_messages m ON m.source_id=g.source_id AND m.message_id=g.sample_message_id
      WHERE g.source_id=$1 AND (m.message_id IS NULL OR m.deleted_at IS NOT NULL)
    `, [id]);
    assert.equal(invalidSamples.rows[0].count, 0, "graph sample messages must remain valid");

    await pool.query("DELETE FROM tg_messages WHERE source_id=$1 AND message_id=1000", [id]);
    const count = await pool.query("SELECT message_count FROM tg_source_message_counters WHERE source_id=$1", [id]);
    assert.equal(Number(count.rows[0].message_count), 99);
  } finally {
    await pool.query("DELETE FROM tg_sources WHERE id=$1", [id]);
    await pool.query("UPDATE tg_runtime SET collection_enabled=TRUE WHERE id=1");
    await pool.end();
  }
});
