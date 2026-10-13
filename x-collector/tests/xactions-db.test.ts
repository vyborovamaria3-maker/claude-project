import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { httpQueryFingerprint, writeHttpPageInTransaction, type HttpPageWrite } from "../src/xactions/checkpoint-store";

test("XActions cursor and posts commit atomically, reject stale cursors and expired leases", async () => {
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
    const deadline = Date.now() + 300000;
    await db.query("INSERT INTO x_tasks VALUES(7,'worker-1',1,'claimed',$1)", [deadline]);
    await db.query("INSERT INTO x_accounts VALUES('collector','owner-1',$1)", [deadline]);

    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        const result = await db.query(sql, params);
        return { ...result, rowCount: result.affectedRows ?? result.rows.length };
      },
    } as unknown as PoolClient;

    const base: HttpPageWrite = {
      taskId: 7, sourceKind: "list", sourceKey: "1945268064792068152",
      queryFingerprint: httpQueryFingerprint({ source: "test" }),
      lease: { workerId: "worker-1", attempt: 1, accountName: "collector", accountOwner: "owner-1" },
      expectedCursor: null, nextCursor: "opaque-1", itemsWritten: 1, completed: false,
    };

    async function transaction(action: () => Promise<void>): Promise<void> {
      await db.exec("BEGIN");
      try {
        await action();
        await db.exec("COMMIT");
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      }
    }

    await transaction(() => writeHttpPageInTransaction(client, base, async c => {
      await c.query("INSERT INTO collected_posts VALUES('tweet-1')");
    }));
    let cp: { cursor: string | null; pages_committed: number; completed?: boolean } =
      (await db.query<{ cursor: string | null; pages_committed: number }>(
      "SELECT cursor,pages_committed FROM xc_http_checkpoints WHERE task_id=7",
    )).rows[0];
    assert.equal(cp.cursor, "opaque-1");
    assert.equal(cp.pages_committed, 1);

    const second = { ...base, expectedCursor: "opaque-1", nextCursor: null, completed: true };
    await assert.rejects(transaction(() => writeHttpPageInTransaction(client, second, async c => {
      await c.query("INSERT INTO collected_posts VALUES('tweet-2')");
      throw new Error("injected page failure");
    })), /injected page failure/);
    assert.equal((await db.query("SELECT 1 FROM collected_posts")).rows.length, 1);
    cp = (await db.query<{ cursor: string | null; pages_committed: number }>(
      "SELECT cursor,pages_committed FROM xc_http_checkpoints WHERE task_id=7",
    )).rows[0];
    assert.equal(cp.cursor, "opaque-1");
    assert.equal(cp.pages_committed, 1);

    await assert.rejects(transaction(() => writeHttpPageInTransaction(
      client, { ...second, expectedCursor: "stale" },
      async () => { throw new Error("should never write"); },
    )), /stale checkpoint cursor/);

    await db.query("UPDATE x_tasks SET lease_expires_at=1 WHERE id=7");
    await assert.rejects(transaction(() => writeHttpPageInTransaction(client, second,
      async () => { throw new Error("should never write"); },
    )), /task lease lost/);
    await db.query("UPDATE x_tasks SET lease_expires_at=$1 WHERE id=7", [Date.now()+300000]);

    await transaction(() => writeHttpPageInTransaction(client, second, async c => {
      await c.query("INSERT INTO collected_posts VALUES('tweet-2')");
    }));
    cp = (await db.query<{ cursor: string | null; completed: boolean; pages_committed: number }>(
      "SELECT cursor,completed,pages_committed FROM xc_http_checkpoints WHERE task_id=7",
    )).rows[0];
    assert.equal(cp.cursor, null);
    assert.equal(cp.completed, true);
    assert.equal(cp.pages_committed, 2);
    assert.equal((await db.query("SELECT 1 FROM collected_posts")).rows.length, 2);
    await assert.rejects(transaction(() => writeHttpPageInTransaction(client, second, async () => {})),
      /already complete/);
  } finally {
    await db.close();
  }
});
