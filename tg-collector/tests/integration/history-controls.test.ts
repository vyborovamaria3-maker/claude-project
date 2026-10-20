import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("CLI history preserves delayed and in-progress cursors", {
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
    assert.equal(pending.rows[0].cursor_before_id,"400",
      "continue must not erase already committed historical position");
    assert.equal(pending.rows[0].high_message_id,"500");
    assert.ok(new Date(pending.rows[0].run_at).getTime() > Date.now()+55*60*1000,
      "continue must not pull a scheduled pending job ahead of its cooldown");
    const sourceState = await pool.query<{full_history:boolean;history_complete:boolean}>(
      "SELECT full_history,history_complete FROM tg_sources WHERE id=$1",[id]);
    assert.equal(sourceState.rows[0].full_history,true);
    assert.equal(sourceState.rows[0].history_complete,false);
  } finally {
    await pool.query("DELETE FROM tg_sources WHERE id=$1",[id]);
  }
});

test("a delayed recent-only job converted to full history cannot claim completion", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const {pool,migrate} = await import("../../src/db.js");
  const {finishJob} = await import("../../src/queue/jobs.js");
  await migrate();
  const identifier="recent_" + randomUUID().replaceAll("-","").slice(0,13);
  const source=(await pool.query<{id:string}>(`
    INSERT INTO tg_sources(identifier,full_history,history_partial,history_complete)
    VALUES($1,TRUE,TRUE,FALSE) RETURNING id::text`,[identifier])).rows[0].id;
  try {
    const job=(await pool.query(`
      INSERT INTO tg_jobs(source_id,state,base_message_id,high_message_id,cursor_before_id)
      VALUES($1,'delayed',0,500,400) RETURNING *`,[source])).rows[0];
    await finishJob(job,500,false,0);
    const status=(await pool.query<{history_complete:boolean;history_partial:boolean}>(`
      SELECT history_complete,history_partial FROM tg_sources WHERE id=$1`,[source])).rows[0];
    assert.equal(status.history_complete,false,
      "a prior recent-only scan cannot attest to full Telegram history");
    assert.equal(status.history_partial,true);
    const next=(await pool.query<{history_scan_verified:boolean;high_message_id:string|null}>(`
      SELECT history_scan_verified,high_message_id::text FROM tg_jobs WHERE source_id=$1`,[source])).rows[0];
    assert.equal(next.history_scan_verified,false);
    assert.equal(next.high_message_id,null,
      "next worker turn must start a verified scan from Telegram head");
  } finally {
    await pool.query("DELETE FROM tg_sources WHERE id=$1",[source]);
    await pool.end();
  }
});
