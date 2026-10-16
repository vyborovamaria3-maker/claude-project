import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("PostgreSQL queue claims one job under FOR UPDATE SKIP LOCKED concurrency", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const { pool, migrate } = await import("../../src/db.js");
  const { claim } = await import("../../src/queue/jobs.js");
  await migrate();

  const marker = "queue_concurrency_" + randomUUID().replaceAll("-", "").slice(0, 20);
  const client = await pool.connect();
  const originalJobs: Array<{ id: string; state: string; run_at: Date; locked_until: Date | null }> = [];
  let sourceId: string | undefined;
  try {
    const existing = await client.query<{ id: string; state: string; run_at: Date; locked_until: Date | null }>(
      "SELECT id::text,state,run_at,locked_until FROM tg_jobs WHERE state IN ('pending','delayed','running') FOR UPDATE"
    );
    originalJobs.push(...existing.rows);
    await client.query(
      "UPDATE tg_jobs SET run_at=now()+interval '1 day', locked_until=now()+interval '1 day' WHERE state IN ('pending','delayed','running')"
    );
    const source = await client.query<{ id: string }>(
      "INSERT INTO tg_sources(identifier,title,enabled) VALUES($1,$2,TRUE) RETURNING id::text",
      [marker, "Queue concurrency fixture"]
    );
    sourceId = source.rows[0].id;
    await client.query(
      "INSERT INTO tg_jobs(source_id,state,run_at) VALUES($1,'pending',now())",
      [sourceId]
    );
    await client.query("COMMIT");

    const [first, second] = await Promise.all([claim(), claim()]);
    const claimed = [first, second].filter(Boolean);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.source_id, sourceId);
  } finally {
    await client.query("BEGIN").catch(() => {});
    if (sourceId) await client.query("DELETE FROM tg_sources WHERE id=$1", [sourceId]);
    for (const job of originalJobs) {
      await client.query(
        "UPDATE tg_jobs SET state=$2,run_at=$3,locked_until=$4 WHERE id=$1",
        [job.id, job.state, job.run_at, job.locked_until]
      );
    }
    await client.query("COMMIT").catch(() => {});
    client.release();
    await pool.end();
  }
});
