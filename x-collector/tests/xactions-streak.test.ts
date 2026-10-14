import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { httpQueryFingerprint, writeHttpPageInTransaction, type HttpPageWrite } from "../src/xactions/checkpoint-store";
import { runCursorPages, HttpNoProgressError } from "../src/xactions/pagination";

test("zero-new-item streak commits with cursor and survives worker reclaim", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE x_tasks (
      id bigint PRIMARY KEY, claimed_by text, attempts integer, status text, lease_expires_at bigint
    ); CREATE TABLE x_accounts (
      name text PRIMARY KEY, account_claimed_by text, account_busy_until bigint
    );`);
    await db.exec(await fs.readFile("migrations/041_xactions_checkpoints.sql", "utf8"));
    await db.exec(await fs.readFile("migrations/043_xactions_progress.sql", "utf8"));
    const deadline=Date.now()+300000;
    await db.query("INSERT INTO x_tasks VALUES (21,'worker-one',1,'claimed',$1)",[deadline]);
    await db.query("INSERT INTO x_accounts VALUES ('collector','owner-one',$1)",[deadline]);
    const client = { query: async (sql:string, params:unknown[] = []) => {
      const res = await db.query(sql,params);
      return { ...res, rowCount: /^\s*(SELECT|WITH)\b/i.test(sql) ? res.rows.length : (res.affectedRows ?? res.rows.length) };
    }} as unknown as PoolClient;
    const base = {
      taskId:21, sourceKind:"list" as const, sourceKey:"1878727153048777016",
      queryFingerprint:httpQueryFingerprint({source:"retry"}),
    };
    async function commit(write:HttpPageWrite) {
      await db.exec("BEGIN");
      try {
        await writeHttpPageInTransaction(client,write,async () => 0);
        await db.exec("COMMIT");
      } catch (error) { await db.exec("ROLLBACK"); throw error; }
    }
    const firstLease = {workerId:"worker-one",attempt:1,accountName:"collector",accountOwner:"owner-one"};
    await commit({...base,lease:firstLease,expectedCursor:null,nextCursor:"next-one",completed:false,itemsWritten:0});
    await commit({...base,lease:firstLease,expectedCursor:"next-one",nextCursor:"next-two",completed:false,itemsWritten:0});
    let state = (await db.query<{consecutive_empty_pages:number;cursor:string}>(
      "SELECT consecutive_empty_pages,cursor FROM xc_http_checkpoints WHERE task_id=21"
    )).rows[0];
    assert.equal(state.consecutive_empty_pages,2);
    assert.equal(state.cursor,"next-two");
    // An abandoned worker attempt is reclaimed without clearing the streak.
    await db.query("UPDATE x_tasks SET claimed_by='worker-two',attempts=2 WHERE id=21");
    await db.query("UPDATE x_accounts SET account_claimed_by='owner-two' WHERE name='collector'");
    const newLease = {workerId:"worker-two",attempt:2,accountName:"collector",accountOwner:"owner-two"};
    await assert.rejects(runCursorPages(async cursor => ({
      items:["already-observed"],nextCursor: cursor==="next-two"?"next-three":"unexpected",
    }), async page => {
      await commit({...base,lease:newLease,expectedCursor:"next-two",
        nextCursor:page.nextCursor, completed:page.completed,itemsWritten:page.items.length});
      return 0;
    }, {initialCursor:"next-two",maxPages:20,stopAfterItems:100,
      itemsCommittedBefore:0, consecutiveEmptyBefore:state.consecutive_empty_pages,
      maxPagesWithoutNewItems:3}), HttpNoProgressError);
    state = (await db.query<{consecutive_empty_pages:number;cursor:string}>(
      "SELECT consecutive_empty_pages,cursor FROM xc_http_checkpoints WHERE task_id=21"
    )).rows[0];
    assert.equal(state.consecutive_empty_pages,3);
    assert.equal(state.cursor,"next-three");
  } finally { await db.close(); }
});
