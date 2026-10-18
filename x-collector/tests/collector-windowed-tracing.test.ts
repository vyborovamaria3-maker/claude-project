import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs/promises";
import { windowedTaskKey } from "../src/collector/queue/windowed";
import { TASK_STAGES } from "../src/collector/monitoring/tracing";

test("window idempotency key survives JSON reordering and changes each window",()=>{
  const base={
    kind:"search" as const,sourceKey:"list:123",windowStart:3600000,windowEnd:4500000,
    payload:{query:"from:test",limit:100,options:{sort:"latest",x:true}},
  };
  const same={...base,payload:{options:{x:true,sort:"latest"},limit:100,query:"from:test"}};
  assert.equal(windowedTaskKey(base),windowedTaskKey(same));
  assert.notEqual(windowedTaskKey(base),windowedTaskKey({...base,windowStart:4500000,windowEnd:5400000}));
  assert.notEqual(windowedTaskKey(base),windowedTaskKey({...base,sourceKey:"list:124"}));
  assert.throws(()=>windowedTaskKey({...base,windowStart:4500000}),/window/);
  assert.throws(()=>windowedTaskKey({...base,windowEnd:3600000}),/window/);
});
test("collector task tracing schema restricts stages and excludes raw secrets",async()=>{
 const db=new PGlite();
 try{
  await db.exec("CREATE TABLE x_tasks(id bigint PRIMARY KEY); INSERT INTO x_tasks VALUES(1)");
  await db.exec(await fs.readFile("migrations/045_collector_trace.sql","utf8"));
  assert(TASK_STAGES.includes("checkpoint"));
  await db.query("INSERT INTO xc_task_events(task_id,worker_id,attempt,stage,observed_count,created_at) VALUES(1,'worker',1,'saving',2,1234)");
  await assert.rejects(db.query("INSERT INTO xc_task_events(task_id,worker_id,attempt,stage,created_at) VALUES(1,'worker',1,'secret=xyz',1234)"));
  await assert.rejects(db.query("INSERT INTO xc_task_events(task_id,worker_id,attempt,stage,observed_count,created_at) VALUES(1,'worker',1,'saving',-1,1234)"));
  assert.equal((await db.query("SELECT id FROM xc_task_events")).rows.length,1);
 }finally{await db.close();}
});
