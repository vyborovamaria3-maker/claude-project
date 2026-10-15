import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, migrate } from "../src/db.js";
import { persistMessage } from "../src/persistence/messages.js";
import { refreshGraphDays } from "../src/analytics/rollups.js";

test("PostgreSQL: migrations, evidence replacement, and cascading removal", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  await migrate();
  const handle = "test_" + randomUUID().replaceAll("-", "").slice(0, 20);
  const source = await pool.query<{ id: string }>(
    "INSERT INTO tg_sources(identifier) VALUES($1) RETURNING id::text", [handle]);
  const id = source.rows[0].id;
  const msg = {
    id: 7, message: "@SomeChannel https://t.me/SomeChannel",
    date: Math.floor(Date.now()/1000),
    fwdFrom: { fromId: { className: "PeerChannel", channelId: { toString: () => "12345" } } },
  };
  try {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await persistMessage(tx, id, msg);
      await persistMessage(tx, id, msg); // Duplicate ingestion must remain idempotent.
      await tx.query("COMMIT");
    } catch (error) { await tx.query("ROLLBACK"); throw error; }
    finally { tx.release(); }
    const first = await pool.query<{kind:string;target_kind:string;target_key:string}>(
      "SELECT kind,target_kind,target_key FROM tg_message_links WHERE source_id=$1 ORDER BY kind", [id]);
    assert.equal(first.rowCount,2);
    assert.equal(first.rows.filter(x=>x.kind==="forward").length,1);
    assert.equal(first.rows.filter(x=>x.kind==="mention").length,1);

    const second = await pool.connect();
    try {
      await second.query("BEGIN");
      await persistMessage(second,id,{id:7,message:"Post edited without links",date:msg.date});
      await second.query("COMMIT");
    } catch (error) { await second.query("ROLLBACK"); throw error; }
    finally { second.release(); }
    const linked = await pool.query<{count:number}>(
      "SELECT count(*)::integer AS count FROM tg_message_links WHERE source_id=$1", [id]);
    assert.equal(linked.rows[0].count,0, "Removed links must not remain after reindex");

    const actual = await pool.query<{count:number; text:string; analysis_version:number}>(
      "SELECT count(*) OVER()::integer AS count,text,analysis_version FROM tg_messages WHERE source_id=$1", [id]);
    assert.equal(actual.rows.length,1);
    assert.equal(actual.rows[0].count,1);
    assert.equal(actual.rows[0].analysis_version,2);
    assert.equal(actual.rows[0].text,"Post edited without links");
    // One deleted publication must not remove other independent evidence.
    const day = new Date(msg.date * 1000).toISOString().slice(0,10);
    const third = await pool.connect();
    try {
      await third.query("BEGIN");
      for (const idOfMessage of [8,9]) {
        await persistMessage(third,id,{id:idOfMessage,message:"@SomeChannel",date:msg.date});
      }
      await refreshGraphDays(third,id,[day]);
      await third.query("COMMIT");
    } catch (error) { await third.query("ROLLBACK"); throw error; }
    finally { third.release(); }
    const beforeDelete = await pool.query<{evidence_count:number}>(
      "SELECT evidence_count FROM tg_graph_daily_edges WHERE source_id=$1 AND target_key='somechannel' AND kind='mention'",[id]);
    assert.equal(beforeDelete.rows[0]?.evidence_count,2);

    const fourth = await pool.connect();
    try {
      await fourth.query("BEGIN");
      await fourth.query("DELETE FROM tg_messages WHERE source_id=$1 AND message_id=8",[id]);
      await refreshGraphDays(fourth,id,[day]);
      await fourth.query("COMMIT");
    } catch (error) { await fourth.query("ROLLBACK"); throw error; }
    finally { fourth.release(); }
    const afterDelete = await pool.query<{evidence_count:number}>(
      "SELECT evidence_count FROM tg_graph_daily_edges WHERE source_id=$1 AND target_key='somechannel' AND kind='mention'",[id]);
    assert.equal(afterDelete.rows[0]?.evidence_count,1, "Remaining message still proves the relationship");
    const survivor = await pool.query("SELECT 1 FROM tg_message_links WHERE source_id=$1 AND message_id=9",[id]);
    assert.equal(survivor.rowCount,1);

  } finally {
    await pool.query("DELETE FROM tg_sources WHERE id=$1", [id]);
    const residual = await pool.query<{count:number}>(
      "SELECT count(*)::integer AS count FROM tg_messages WHERE source_id=$1", [id]);
    assert.equal(residual.rows[0].count,0);
    const residue = await pool.query("SELECT 1 FROM tg_graph_daily_edges WHERE source_id=$1",[id]);
    assert.equal(residue.rowCount,0);
    await pool.end();
  }
});
