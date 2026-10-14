import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { runCursorPages } from "../src/xactions/pagination";
import { httpQueryFingerprint, writeHttpPageInTransaction, type HttpPageWrite } from "../src/xactions/checkpoint-store";

test("HTTP cursor survives a worker crash, new account lease and new task attempt", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE x_tasks (
      id bigint PRIMARY KEY, claimed_by text, attempts integer, status text, lease_expires_at bigint
    );
    CREATE TABLE x_accounts (
      name text PRIMARY KEY, account_claimed_by text, account_busy_until bigint
    );
    CREATE TABLE collected_posts (id text PRIMARY KEY);`);
    await db.exec(await fs.readFile("migrations/041_xactions_checkpoints.sql", "utf8"));
    const leaseUntil = Date.now() + 300_000;
    await db.query("INSERT INTO x_tasks VALUES (11,'first-worker',1,'claimed',$1)", [leaseUntil]);
    await db.query("INSERT INTO x_accounts VALUES ('collector','first-owner',$1)", [leaseUntil]);

    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        const res = await db.query(sql, params);
        return { ...res, rowCount: /^\s*(SELECT|WITH)\b/i.test(sql) ? res.rows.length : (res.affectedRows ?? res.rows.length) };
      },
    } as unknown as PoolClient;

    async function transaction(cb: () => Promise<void>): Promise<void> {
      await db.exec("BEGIN");
      try { await cb(); await db.exec("COMMIT"); }
      catch (error) { await db.exec("ROLLBACK"); throw error; }
    }

    const base = {
      taskId: 11, sourceKind: "timeline" as const, sourceKey: "NASA",
      queryFingerprint: httpQueryFingerprint({ handle: "NASA", limit: 3 }),
    };
    async function persist(
      lease: HttpPageWrite["lease"],
      previousCursor: string | null,
      page: { items: readonly string[]; nextCursor: string | null; completed: boolean },
    ): Promise<void> {
      await transaction(() => writeHttpPageInTransaction(client, {
        ...base, lease, expectedCursor: previousCursor, nextCursor: page.nextCursor,
        completed: page.completed, itemsWritten: page.items.length,
      }, async c => {
        for (const id of page.items) await c.query("INSERT INTO collected_posts (id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
      }));
    }
    const firstLease: HttpPageWrite["lease"] = {
      workerId: "first-worker", attempt: 1, accountName: "collector", accountOwner: "first-owner",
    };
    let firstRequests = 0;
    await assert.rejects(runCursorPages(async cursor => {
      firstRequests++;
      if (firstRequests === 1) {
        assert.equal(cursor, null);
        return { items: ["tweet-a", "tweet-b"], nextCursor: "opaque-next" };
      }
      assert.equal(cursor, "opaque-next");
      throw new Error("simulated power loss before second page save");
    }, page => persist(firstLease, page.pageNumber === 1 ? null : "opaque-next", page),
    { maxPages: 10, stopAfterItems: 3 }), /simulated power loss/);

    const saved = (await db.query<{ cursor: string | null; items_committed: string }>(
      "SELECT cursor,items_committed FROM xc_http_checkpoints WHERE task_id=11",
    )).rows[0];
    assert.equal(saved.cursor, "opaque-next");
    assert.equal(Number(saved.items_committed), 2);
    assert.equal((await db.query("SELECT id FROM collected_posts")).rows.length, 2);

    // Task lease expires and another worker receives a new attempt/account lease.
    await db.query("UPDATE x_tasks SET claimed_by='second-worker',attempts=2,lease_expires_at=$1 WHERE id=11", [Date.now()+300_000]);
    await db.query("UPDATE x_accounts SET account_claimed_by='second-owner',account_busy_until=$1 WHERE name='collector'", [Date.now()+300_000]);
    const newLease: HttpPageWrite["lease"] = {
      workerId: "second-worker", attempt: 2, accountName: "collector", accountOwner: "second-owner",
    };
    let fetched: string | null = null;
    const result = await runCursorPages(async cursor => {
      fetched = cursor;
      return { items: ["tweet-c"], nextCursor: null };
    }, page => persist(newLease, saved.cursor, page), {
      initialCursor: saved.cursor, itemsCommittedBefore: Number(saved.items_committed),
      maxPages: 10, stopAfterItems: 3,
    });
    assert.equal(fetched, "opaque-next");
    assert.equal(result.completed, true);
    assert.equal(result.itemsCommitted, 3);
    const postRows = (await db.query<{ id: string }>("SELECT id FROM collected_posts ORDER BY id")).rows;
    assert.deepEqual(postRows.map(p => p.id), ["tweet-a", "tweet-b", "tweet-c"]);
    const latest = (await db.query<{ pages_committed: number; completed: boolean; cursor: string | null }>(
      "SELECT pages_committed,completed,cursor FROM xc_http_checkpoints WHERE task_id=11",
    )).rows[0];
    assert.equal(latest.pages_committed, 2);
    assert.equal(latest.completed, true);
    assert.equal(latest.cursor, null);
  } finally {
    await db.close();
  }
});
