import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("CLI historical scan preserves a delayed Telegram job and queues pending history", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const { pool, migrate } = await import("../../src/db.js");
  await migrate();
  const identifier = "historydelay_" + randomUUID().replaceAll("-", "").slice(0, 12);
  const source = await pool.query<{id:string}>(
    "INSERT INTO tg_sources(identifier) VALUES($1) RETURNING id::text", [identifier]
  );
  const id = source.rows[0].id;
  const history = () => execFileSync(
    process.execPath, ["--import", "tsx", "src/cli.ts", "history", "@" + identifier],
    {cwd: process.cwd(), stdio:"pipe",timeout:30_000}
  );
  try {
    await pool.query("INSERT INTO tg_jobs(source_id,state,run_at,high_message_id,cursor_before_id) VALUES($1,'delayed',now()+interval '30 minutes',500,400)",[id]);
    const before = await pool.query<{run_at:Date}>(
      "SELECT run_at FROM tg_jobs WHERE source_id=$1",[id]);
    history();
    const afterDelay = await pool.query<{
      state:string;run_at:Date;cursor_before_id:string|null;
    }>("SELECT state,run_at,cursor_before_id::text FROM tg_jobs WHERE source_id=$1",[id]);
    assert.equal(afterDelay.rows[0].state,"delayed");
    assert.equal(afterDelay.rows[0].cursor_before_id,"400");
    assert.equal(new Date(afterDelay.rows[0].run_at).getTime(),
      new Date(before.rows[0].run_at).getTime(),
      "manually enabling full history must not evade Telegram per-source delay");

    await pool.query("UPDATE tg_jobs SET state='pending',run_at=now()+interval '1 hour' WHERE source_id=$1",[id]);
    history();
    const pending = await pool.query<{
      state:string; cursor_before_id:string|null; high_message_id:string|null; run_at:Date;
    }>("SELECT state,cursor_before_id::text,high_message_id::text,run_at FROM tg_jobs WHERE source_id=$1",[id]);
    assert.equal(pending.rows[0].state,"pending");
    assert.equal(pending.rows[0].cursor_before_id,null);
    assert.equal(pending.rows[0].high_message_id,null);
    assert.ok(new Date(pending.rows[0].run_at).getTime() <= Date.now() + 5000);
    const sourceState = await pool.query<{full_history:boolean;history_complete:boolean}>(
      "SELECT full_history,history_complete FROM tg_sources WHERE id=$1",[id]);
    assert.equal(sourceState.rows[0].full_history,true);
    assert.equal(sourceState.rows[0].history_complete,false);
  } finally {
    await pool.query("DELETE FROM tg_sources WHERE id=$1",[id]);
    await pool.end();
  }
});
