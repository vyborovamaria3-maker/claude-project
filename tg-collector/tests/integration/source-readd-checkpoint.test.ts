import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("CLI add --full preserves historical and fresh cursors on re-add and manual retry", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const { pool, migrate } = await import("../../src/db.js");
  await migrate();
  const identifier = "readd_" + randomUUID().replaceAll("-", "").slice(0, 18);
  const source = await pool.query<{id:string}>(`
    INSERT INTO tg_sources(identifier,full_history,history_partial)
    VALUES($1,TRUE,TRUE) RETURNING id::text`, [identifier]);
  const sourceId = source.rows[0].id;
  const add = () => execFileSync(process.execPath,
    ["--import", "tsx", "src/cli.ts", "add", "@" + identifier, "--full"],
    { cwd: process.cwd(), stdio: "pipe", timeout: 30_000 });
  const checkpoint = async () => (await pool.query<{
    state:string; attempts:number; run_at:Date;
    base_message_id:string|null; high_message_id:string|null;
    cursor_before_id:string|null; scanned_count:number;
    fresh_base_message_id:string|null; fresh_high_message_id:string|null;
    fresh_cursor_before_id:string|null;
  }>(`
    SELECT state,attempts,run_at,base_message_id::text,high_message_id::text,
      cursor_before_id::text,scanned_count,fresh_base_message_id::text,
      fresh_high_message_id::text,fresh_cursor_before_id::text
    FROM tg_jobs WHERE source_id=$1`, [sourceId])).rows[0];
  try {
    await pool.query(`
      INSERT INTO tg_jobs(source_id,state,run_at,base_message_id,high_message_id,
        cursor_before_id,scanned_count,fresh_base_message_id,
        fresh_high_message_id,fresh_cursor_before_id)
      VALUES($1,'pending',now()+interval '15 minutes',0,1000,900,100,1000,1100,1050)
    `, [sourceId]);
    const initial = await checkpoint();
    add();
    add();
    assert.deepEqual(await checkpoint(), initial,
      "repeated add must not discard old or new message cursor or hurry scheduled jobs");

    await pool.query(`
      UPDATE tg_jobs SET state='failed',attempts=5,last_error='TG_TRANSIENT_ERROR',
        run_at=now()+interval '15 minutes' WHERE source_id=$1`, [sourceId]);
    const failed = await checkpoint();
    add();
    const retried = await checkpoint();
    assert.equal(retried.state,"pending");
    assert.equal(retried.attempts,0);
    assert.ok(new Date(retried.run_at).getTime()<=Date.now()+5000);
    for (const key of ["base_message_id","high_message_id","cursor_before_id",
      "scanned_count","fresh_base_message_id","fresh_high_message_id",
      "fresh_cursor_before_id"] as const) {
      assert.equal(retried[key],failed[key],`resuming a failed job must preserve ${key}`);
    }
  } finally {
    await pool.query("DELETE FROM tg_sources WHERE id=$1",[sourceId]);
    await pool.end();
  }
});
