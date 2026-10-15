import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, migrate } from "../src/db.js";
import { persistMessage } from "../src/persistence/messages.js";

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
    assert.equal(actual.rows[0].analysis_version,1);
    assert.equal(actual.rows[0].text,"Post edited without links");
  } finally {
    await pool.query("DELETE FROM tg_sources WHERE id=$1", [id]);
    const residual = await pool.query<{count:number}>(
      "SELECT count(*)::integer AS count FROM tg_messages WHERE source_id=$1", [id]);
    assert.equal(residual.rows[0].count,0);
    await pool.end();
  }
});
