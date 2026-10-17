import "dotenv/config";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";

test("PostgreSQL: FloodWait globally pauses claims and allows resume after pause", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const { pool, migrate } = await import("../../src/db.js");
  const { claim, handleFailure } = await import("../../src/queue/jobs.js");
  await migrate();
  const source = await pool.query<{id: string}>(
    "INSERT INTO tg_sources(identifier) VALUES($1) RETURNING id::text",
    ["flood_" + randomUUID().replaceAll("-", "").slice(0, 18)],
  );
  const sourceId = source.rows[0].id;
  let claimedElsewhere: string | null = null;
  try {
    await pool.query("UPDATE tg_runtime SET collection_enabled=TRUE,block_reason=NULL,blocked_at=NULL,pause_until=NULL WHERE id=1");
    await pool.query("INSERT INTO tg_jobs(source_id) VALUES($1)", [sourceId]);
    const job = await claim();
    assert.ok(job);
    assert.equal(job.source_id, sourceId);
    await handleFailure(job, Object.assign(new Error("FLOOD_WAIT_60"), { seconds: 60 }));

    const runtime = await pool.query<{pause_until: Date; last_error_code: string}>(
      "SELECT pause_until,last_error_code FROM tg_runtime WHERE id=1",
    );
    assert.equal(runtime.rows[0].last_error_code, "TG_FLOOD_WAIT");
    assert.ok(runtime.rows[0].pause_until.getTime() > Date.now() + 63_000);
    assert.ok(runtime.rows[0].pause_until.getTime() < Date.now() + 92_000);
    assert.equal(await claim(), undefined, "global pause must prevent every new claim");

    await pool.query("UPDATE tg_runtime SET pause_until=now()-interval '1 second' WHERE id=1");
    await pool.query("UPDATE tg_jobs SET run_at=now()-interval '1 hour' WHERE source_id=$1", [sourceId]);
    const resumed = await claim();
    assert.ok(resumed, "a job should be claimable after the global pause expires");
    if (resumed.source_id !== sourceId) {
      claimedElsewhere = resumed.id;
      await pool.query("UPDATE tg_jobs SET state='pending',locked_until=NULL,run_at=now() WHERE id=$1", [resumed.id]);
    } else {
      assert.equal(resumed.source_id, sourceId);
    }
  } finally {
    if (claimedElsewhere) await pool.query("UPDATE tg_jobs SET state='pending',locked_until=NULL WHERE id=$1", [claimedElsewhere]);
    await pool.query("DELETE FROM tg_sources WHERE id=$1", [sourceId]);
    await pool.query("UPDATE tg_runtime SET collection_enabled=TRUE,block_reason=NULL,blocked_at=NULL,pause_until=NULL,last_error_code=NULL WHERE id=1");
    await pool.end();
  }
});
