import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("PostgreSQL: historical and active link counters follow soft deletion and restoration", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const { pool, migrate } = await import("../../src/db.js");
  const { persistMessage, markMessageDeleted } = await import("../../src/persistence/messages.js");
  await migrate();
  const counts = async () => {
    const result = await pool.query<{links_total:string;links_active_total:string}>(
      "SELECT links_total::text,links_active_total::text FROM tg_runtime_metrics WHERE id=1"
    );
    return {
      total: BigInt(result.rows[0].links_total),
      active: BigInt(result.rows[0].links_active_total),
    };
  };
  const before = await counts();
  let sourceId: string | null = null;
  try {
    const source = await pool.query<{id:string}>(
      "INSERT INTO tg_sources(identifier) VALUES($1) RETURNING id::text",
      ["active_links_" + randomUUID().replaceAll("-", "").slice(0, 12)]
    );
    sourceId = source.rows[0].id;
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await persistMessage(tx, sourceId, {
        id: 55, message: "Reference @MetricEvidence",
        date: Math.floor(Date.now() / 1000),
      });
      await tx.query("COMMIT");
    } catch (error) { await tx.query("ROLLBACK"); throw error; }
    finally { tx.release(); }

    const inserted = await counts();
    assert.equal(inserted.total, before.total + 1n);
    assert.equal(inserted.active, before.active + 1n);

    const del = await pool.connect();
    try {
      await del.query("BEGIN");
      assert.equal(await markMessageDeleted(del, sourceId, 55), true);
      await del.query("COMMIT");
    } catch (error) { await del.query("ROLLBACK"); throw error; }
    finally { del.release(); }

    const orphaned = await counts();
    assert.equal(orphaned.total, inserted.total, "historical evidence remains");
    assert.equal(orphaned.active, before.active, "deleted message no longer counts as active");

    await pool.query(
      "UPDATE tg_messages SET deleted_at=NULL WHERE source_id=$1 AND message_id=55",
      [sourceId]
    );
    const restored = await counts();
    assert.equal(restored.total, inserted.total);
    assert.equal(restored.active, inserted.active);
  } finally {
    if (sourceId) await pool.query("DELETE FROM tg_sources WHERE id=$1", [sourceId]);
    const clean = await counts();
    assert.deepEqual(clean, before, "cascade must restore both counters");
    await pool.end();
  }
});
