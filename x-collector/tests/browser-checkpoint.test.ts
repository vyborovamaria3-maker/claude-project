import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { taskFailure } from "../lib/trade/task-errors";
import { safeLastErrorCode } from "../src/collector/queue/task-status";
import {
 browserFingerprint,browserResumeQuery,writeBrowserBatchInTransaction,
 type BrowserCheckpointWrite,
} from "../src/collector/persistence/browser-checkpoint";

test("conservative browser resume never assumes an ordered X search without explicit opt-in",()=>{
 const checkpoint={observedCount:3,oldestId:"1878727153048777016",newestId:"1878727153048777020",coverage:"partial" as const};
 const initial=browserResumeQuery("memecoin","latest",10,checkpoint,false);
 assert.deepEqual(initial,{query:"memecoin",limit:10,usingCursor:false});
 const resumed=browserResumeQuery("memecoin","latest",10,checkpoint,true);
 assert.deepEqual(resumed,{query:"memecoin max_id:1878727153048777015",limit:7,usingCursor:true});
 assert.equal(browserResumeQuery("memecoin","top",10,checkpoint,true).usingCursor,false);
 assert.equal(browserResumeQuery("memecoin max_id:123","latest",10,checkpoint,true).usingCursor,false);
 assert.equal(browserResumeQuery("memecoin since_id:123","latest",10,checkpoint,true).usingCursor,false);
});

test("browser post batch and lease-fenced checkpoint commit atomically and deduplicate",async()=>{
 const db=new PGlite();
 try{
  await db.exec(`CREATE TABLE x_tasks (id bigint PRIMARY KEY, status text, attempts integer, claimed_by text, lease_expires_at bigint);
   CREATE TABLE x_accounts (name text PRIMARY KEY,account_claimed_by text,account_busy_until bigint);
   CREATE TABLE saved_posts (id text PRIMARY KEY);`);
  await db.exec(await fs.readFile("migrations/044_browser_checkpoints.sql","utf8"));
  const expiry=Date.now()+300000;
  await db.query("INSERT INTO x_tasks VALUES (7,'claimed',1,'worker-a',$1)",[expiry]);
  await db.query("INSERT INTO x_accounts VALUES ('acct','account-owner',$1)",[expiry]);
  const fake={
    query:async(sql:string,params:unknown[]=[])=>{
      const r=await db.query(sql,params);
      return {...r,rowCount:/^\s*(SELECT|WITH)\b/i.test(sql)?r.rows.length:(r.affectedRows??r.rows.length)};
    }
  } as unknown as PoolClient;
  const write:BrowserCheckpointWrite={
    taskId:7,fingerprint:browserFingerprint("search","test",10,"latest"),
    lease:{workerId:"worker-a",attempt:1,accountName:"acct",accountOwner:"account-owner"},
    ids:["1878727153048777016","1878727153048777017"],
  };
  async function atomic(f:()=>Promise<unknown>) {
    await db.exec("BEGIN");
    try {const result=await f();await db.exec("COMMIT");return result;}
    catch(e){await db.exec("ROLLBACK");throw e;}
  }
  const save=async(client:PoolClient)=>{
    const r=await client.query("INSERT INTO saved_posts SELECT unnest($1::text[]) ON CONFLICT DO NOTHING RETURNING id",[write.ids]);
    return r.rows.length;
  };
  assert.equal(await atomic(()=>writeBrowserBatchInTransaction(fake,write,save)),2);
  assert.equal(await atomic(()=>writeBrowserBatchInTransaction(fake,write,save)),0);
  let saved=(await db.query<{observed_count:string;oldest_id:string;newest_id:string}>(
    "SELECT observed_count::text,oldest_id,newest_id FROM xc_browser_checkpoints WHERE task_id=7")).rows[0];
  assert.equal(saved.observed_count,"2");
  assert.equal(saved.oldest_id,"1878727153048777016");
  assert.equal(saved.newest_id,"1878727153048777017");
  await assert.rejects(atomic(()=>writeBrowserBatchInTransaction(fake,{...write,lease:{...write.lease,accountOwner:"stolen"}},save)),/lease lost/);
  await assert.rejects(atomic(()=>writeBrowserBatchInTransaction(fake,{...write,fingerprint:browserFingerprint("search","changed",10,"latest")},save)),/CHECKPOINT_CHANGED/);
  const fail={...write,ids:["1878727153048777018"]};
  await assert.rejects(atomic(()=>writeBrowserBatchInTransaction(fake,fail,async client=>{
    await client.query("INSERT INTO saved_posts VALUES($1)",[fail.ids[0]]);
    throw new Error("simulated power loss");
  })),/simulated power loss/);
  assert.equal((await db.query("SELECT id FROM saved_posts")).rows.length,2);
  saved=(await db.query<{observed_count:string;oldest_id:string;newest_id:string}>(
    "SELECT observed_count::text,oldest_id,newest_id FROM xc_browser_checkpoints WHERE task_id=7")).rows[0];
  assert.equal(saved.observed_count,"2");
  assert.equal(saved.newest_id,"1878727153048777017");
 }finally{await db.close();}
});

test("checkpoint ownership and shape errors never punish X sessions",()=>{
  const changed=taskFailure(new Error("BROWSER_CHECKPOINT_CHANGED"));
  assert.deepEqual(changed,{code:"BROWSER_CHECKPOINT_CHANGED",permanent:true,retryAfterMs:0});
  const lost=taskFailure(new Error("Browser checkpoint account lease lost"));
  assert.equal(lost.code,"ACCOUNT_LEASE_LOST");
  assert.equal(lost.permanent,false);
  assert.equal(safeLastErrorCode("[BROWSER_CHECKPOINT_CHANGED] no raw state"),"BROWSER_CHECKPOINT_CHANGED");
});
