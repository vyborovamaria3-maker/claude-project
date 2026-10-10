import { REQUIRED } from "../lib/trade/migrations";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { executeMonitoringCycle } from "../lib/trade/graph-monitoring";

test("PostgreSQL engine: full migration chain, persistence, retries and atomic rollback", async () => {
  const db = new PGlite();
  const client = { query: async (sql: string, params: unknown[] = []) => {
    const r = await db.query(sql, params);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  } } as unknown as Pick<PoolClient, "query">;
  try {
    const dir = path.resolve("migrations");
    const migrations = REQUIRED;
    assert.equal(migrations.length, 27);
    for (const file of migrations) {
      await db.exec("BEGIN");
      try {
        await db.exec(await fs.readFile(path.join(dir, file), "utf8"));
        await db.exec("COMMIT");
      } catch (error) { await db.exec("ROLLBACK"); throw error; }
    }
    for (let i = 0; i < 20; i++) {
      await db.query("INSERT INTO twitter_tweets(tweet_id,handle,text,posted_at,first_seen_at,updated_at) VALUES($1,$1,'post',9750,9750,9750)", [String(i)]);
      await db.query("INSERT INTO tweet_token_links(tweet_id,mint,handle,linked_at) VALUES($1,'mint-a',$1,9750)", [String(i)]);
      await db.query("INSERT INTO author_reputation(handle,reputation_score,updated_at) VALUES($1,100,9750)", [String(i)]);
    }
    await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const first = await executeMonitoringCycle(client, 10500, 1000);
    assert.equal(first.signals, 1); assert.equal(first.events, 1);
    await db.exec("COMMIT");
    const history = (await db.query<{ score: string; level: string; payload: { entity: string } }>("SELECT * FROM graph_signal_history")).rows[0];
    assert.equal(history.level, "CRITICAL"); assert.ok(Number(history.score) >= 80);
    assert.equal(history.payload.entity, "token:mint-a");
    await db.exec("BEGIN");
    const retry = await executeMonitoringCycle(client, 10900, 1000);
    assert.equal(retry.signals, 0); assert.equal(retry.events, 0);
    await db.exec("COMMIT");
    await db.exec("BEGIN");
    const rolledBack = await executeMonitoringCycle(client, 10000, 500);
    assert.equal(rolledBack.signals, 1); assert.equal(rolledBack.events, 1);
    await db.exec("ROLLBACK");
    assert.equal((await db.query<{ n: number }>("SELECT count(*)::int n FROM graph_signal_history")).rows[0].n, 1);
    assert.equal((await db.query<{ n: number }>("SELECT count(*)::int n FROM graph_priority_events")).rows[0].n, 1);
    // Fail the event INSERT after history INSERT, then prove neither write survives.
    await db.exec(`CREATE FUNCTION reject_graph_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected event write failure'; END $$;
      CREATE TRIGGER reject_graph_event BEFORE INSERT ON graph_priority_events
      FOR EACH ROW EXECUTE FUNCTION reject_graph_event();`);
    await db.exec("BEGIN");
    await assert.rejects(executeMonitoringCycle(client, 10000, 500), /injected event write failure/);
    await db.exec("ROLLBACK");
    assert.equal((await db.query<{ n: number }>("SELECT count(*)::int n FROM graph_signal_history")).rows[0].n, 1);
  } finally { await db.close(); }
});
