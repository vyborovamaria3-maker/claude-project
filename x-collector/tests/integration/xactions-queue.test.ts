import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { claimTasks, deferTask, finishTask } from "../../lib/trade/tasks";
import { getPool, closePool, q1 } from "../../lib/trade/pg";
import { runCursorPages } from "../../src/xactions/pagination";
import { commitHttpPage, httpQueryFingerprint } from "../../src/xactions/checkpoint-store";

test("native PostgreSQL: claim -> partial/checkpoint -> defer -> reclaim -> complete", {
  skip: !process.env.RUNTIME_TEST_DATABASE_URL,
}, async () => {
  const connectionString = process.env.RUNTIME_TEST_DATABASE_URL!;
  const admin = new Pool({ connectionString });
  const schema = "xa_queue_" + randomBytes(6).toString("hex");
  const url = new URL(connectionString);
  url.searchParams.set("options", `-csearch_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const setup = await admin.connect();
    try {
      await setup.query(`SET search_path TO ${schema},public`);
      await setup.query(`CREATE TABLE x_tasks(
        id bigserial PRIMARY KEY,kind text NOT NULL,payload_json jsonb NOT NULL,
        mint text,handle text,priority integer NOT NULL DEFAULT 0,
        available_at bigint NOT NULL DEFAULT 0, created_at bigint NOT NULL DEFAULT 0,
        updated_at bigint NOT NULL DEFAULT 0,idempotency_key text,
        attempts integer NOT NULL DEFAULT 0,max_attempts integer NOT NULL DEFAULT 3,
        claimed_by text,claimed_at bigint,lease_expires_at bigint,
        last_error text,status text NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE x_tasks_dlq(
        original_id bigint,kind text,payload_json jsonb,mint text,handle text,
        attempts integer,last_error text,failed_at bigint
      );
      CREATE TABLE x_accounts(
        name text PRIMARY KEY,account_claimed_by text,account_busy_until bigint
      );
      CREATE TABLE x_task_items(task_id bigint,post_id text,PRIMARY KEY(task_id,post_id));`);
      await setup.query(await fs.readFile(path.resolve("migrations/041_xactions_checkpoints.sql"),"utf8"));
      await setup.query(await fs.readFile(path.resolve("migrations/043_xactions_progress.sql"),"utf8"));
      await setup.query(`INSERT INTO x_tasks(id,kind,payload_json,available_at,created_at,updated_at)
        VALUES(1,'timeline','{"handle":"NASA","limit":3}',0,0,0)`);
      await setup.query(`INSERT INTO x_accounts VALUES('collector','owner-one',$1)`,[Date.now()+600000]);
    } finally { setup.release(); }

    const first = (await claimTasks("worker-one",1,600000))[0];
    assert.ok(first);
    assert.equal(first.id,1);
    assert.equal(first.attempts,1);
    const fingerprint = httpQueryFingerprint({handle:"NASA",limit:3});
    const key = { taskId:1,sourceKind:"timeline" as const,sourceKey:"NASA",queryFingerprint:fingerprint };
    const a = await runCursorPages(async cursor => {
      assert.equal(cursor,null);
      return { items:["post-1"],nextCursor:"opaque-2" };
    }, async page => {
      let inserted=0;
      await commitHttpPage({
        ...key,lease:{workerId:"worker-one",attempt:first.attempts,
          accountName:"collector",accountOwner:"owner-one"},
        expectedCursor:null,nextCursor:page.nextCursor,completed:page.completed,itemsWritten:page.items.length,
      }, async client => {
        const result=await client.query(
          "INSERT INTO x_task_items(task_id,post_id) VALUES(1,'post-1') ON CONFLICT DO NOTHING");
        inserted=result.rowCount??0;
        return inserted;
      });
      return inserted;
    },{maxPages:1,stopAfterItems:3});
    assert.equal(a.completed,false);
    assert.equal(a.itemsCommitted,1);
    assert.equal(await deferTask(1,"worker-one",0,"XActions partial",first.attempts),true);
    let progress=await q1<{status:string;attempts:number}>("SELECT status,attempts FROM x_tasks WHERE id=1");
    assert.equal(progress?.status,"pending");
    assert.equal(progress?.attempts,0);
    const second=(await claimTasks("worker-two",1,600000))[0];
    assert.ok(second);
    assert.equal(second.attempts,1);
    await getPool().query("UPDATE x_accounts SET account_claimed_by='owner-two' WHERE name='collector'");
    const saved=await q1<{cursor:string;pages_committed:number;items_committed:string}>(
      "SELECT cursor,pages_committed,items_committed FROM xc_http_checkpoints WHERE task_id=1");
    assert.equal(saved?.cursor,"opaque-2");
    const b=await runCursorPages(async cursor=>{
      assert.equal(cursor,"opaque-2");
      return {items:["post-2","post-3"],nextCursor:null};
    },async page=>{
      let inserted=0;
      await commitHttpPage({
        ...key,lease:{workerId:"worker-two",attempt:second.attempts,
          accountName:"collector",accountOwner:"owner-two"},
        expectedCursor:saved!.cursor,nextCursor:page.nextCursor,completed:page.completed,itemsWritten:page.items.length,
      },async client=>{
        const result=await client.query(
          "INSERT INTO x_task_items(task_id,post_id) VALUES(1,'post-2'),(1,'post-3') ON CONFLICT DO NOTHING");
        inserted=result.rowCount??0;return inserted;
      });
      return inserted;
    },{initialCursor:saved!.cursor,itemsCommittedBefore:Number(saved!.items_committed),
      maxPages:2,stopAfterItems:3});
    assert.equal(b.itemsCommitted,3);
    assert.equal(b.completed,true);
    assert.equal(await finishTask(1,"worker-two",second.attempts),true);
    progress=await q1<{status:string;attempts:number}>("SELECT status,attempts FROM x_tasks WHERE id=1");
    assert.equal(progress?.status,"done");
    assert.equal(progress?.attempts,1);
    const row=await q1<{n:number}>("SELECT count(*)::int AS n FROM x_task_items WHERE task_id=1");
    assert.equal(row?.n,3);
  } finally {
    await closePool();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(()=>{});
    await admin.end();
  }
});
