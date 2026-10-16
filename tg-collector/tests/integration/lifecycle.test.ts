import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("PostgreSQL: evidence versioning and soft-delete preserve canonical links", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const { pool, migrate } = await import("../src/db.js");
  const { persistMessage, markMessageDeleted } = await import("../src/persistence/messages.js");
  const { refreshGraphDays, utcDay } = await import("../src/analytics/rollups.js");
  await migrate();

  const identifier = "lifecycle_" + randomUUID().replaceAll("-", "").slice(0, 18);
  const client = await pool.connect();
  try {
    const source = await client.query<{ id: string }>(
      "INSERT INTO tg_sources(identifier,title,enabled) VALUES($1,$2,TRUE) RETURNING id::text",
      [identifier, "Lifecycle fixture"],
    );
    const sourceId = source.rows[0].id;
    const postedAt = new Date("2026-10-15T12:00:00Z");
    await client.query("BEGIN");
    await persistMessage(client, sourceId, {
      id: 501,
      message: "@alice 0x1111111111111111111111111111111111111111",
      date: Math.floor(postedAt.getTime() / 1000),
    });
    const links = await client.query<{ analysis_version: number; target_key: string }>(
      "SELECT analysis_version,target_key FROM tg_message_links WHERE source_id=$1 AND message_id=501 ORDER BY target_key",
      [sourceId],
    );
    assert.ok(links.rows.length >= 2);
    assert.ok(links.rows.every(row => row.analysis_version === 2));

    const day = utcDay(postedAt)!;
    await refreshGraphDays(client, sourceId, [day]);
    const activeEdge = await client.query<{ evidence_count: number; message_count: number }>(
      "SELECT evidence_count,message_count FROM tg_graph_daily_edges WHERE source_id=$1 AND day=$2",
      [sourceId, day],
    );
    assert.ok(activeEdge.rows.length >= 2);
    assert.ok(activeEdge.rows.every(row => row.evidence_count === 1 && row.message_count === 1));

    assert.equal(await markMessageDeleted(client, sourceId, 501), true);
    const afterDelete = await client.query<{ deleted_at: Date | null }>(
      "SELECT deleted_at FROM tg_messages WHERE source_id=$1 AND message_id=501",
      [sourceId],
    );
    assert.ok(afterDelete.rows[0]?.deleted_at);
    const retainedLinks = await client.query("SELECT 1 FROM tg_message_links WHERE source_id=$1 AND message_id=501", [sourceId]);
    assert.ok(retainedLinks.rows.length >= 2);
    const deletedEdges = await client.query("SELECT 1 FROM tg_graph_daily_edges WHERE source_id=$1 AND day=$2", [sourceId, day]);
    assert.equal(deletedEdges.rows.length, 0);
    const counter = await client.query<{ message_count: number }>(
      "SELECT message_count FROM tg_source_message_counters WHERE source_id=$1",
      [sourceId],
    );
    assert.equal(counter.rows[0]?.message_count, 0);

    await client.query("UPDATE tg_messages SET deleted_at=NULL WHERE source_id=$1 AND message_id=501", [sourceId]);
    await refreshGraphDays(client, sourceId, [day]);
    const restoredCounter = await client.query<{ message_count: number }>(
      "SELECT message_count FROM tg_source_message_counters WHERE source_id=$1",
      [sourceId],
    );
    assert.equal(restoredCounter.rows[0]?.message_count, 1);
    const restoredEdges = await client.query("SELECT 1 FROM tg_graph_daily_edges WHERE source_id=$1 AND day=$2", [sourceId, day]);
    assert.ok(restoredEdges.rows.length >= 2);
    await client.query("COMMIT");
    await client.query("DELETE FROM tg_sources WHERE id=$1", [sourceId]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});
