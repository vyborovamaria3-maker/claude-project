import test from "node:test";
import assert from "node:assert/strict";
import {processInvalidationBatch} from "../dist/index.js";
const token="solana:So11111111111111111111111111111111111111112";
function fake(attempts=0){
  const queries=[];
  const db={async query(sql,params){
    queries.push({sql,params});
    if(sql.includes("FROM analytics_invalidation_queue")&&sql.includes("FOR UPDATE SKIP LOCKED")){
      return {rows:[{invalidation_id:"1",canonical_token_id:token,source_system:"tg",
        event_kind:"token_links_invalidated",event_key:"test-event",attempts}]};
    }
    if(sql.includes("FROM intelligence_inbox origin"))return {rows:[]};
    return {rows:[]};
  }};
  return {queries,db};
}
test("invalidation worker skips clean queue without writes",async()=>{
  const sql=[];
  const db={async query(q){sql.push(q);return {rows:[]}}};
  const result=await processInvalidationBatch(db,3);
  assert.equal(result.completed,0);assert.equal(result.empty,true);
  assert.deepEqual(sql,["BEGIN",sql[1],"COMMIT"]);
});
test("missing publication day is retried and audited, not silently completed",async()=>{
  const {queries,db}=fake(0);
  const result=await processInvalidationBatch(db,1);
  assert.equal(result.retried,1);assert.equal(result.completed,0);
  assert.ok(queries.some(x=>x.sql.includes("next_attempt_at<=clock_timestamp()")),
    "queued failures must not be immediately reclaimed");
  assert.ok(queries.some(x=>x.sql.includes("LEAST(300,5*power(2")),
    "failed jobs must receive bounded exponential retry delay");
  assert.ok(queries.some(x=>x.sql.includes("ROLLBACK TO SAVEPOINT")));
  assert.ok(queries.some(x=>x.sql.includes("INSERT INTO analytics_invalidation_log")));
  assert.deepEqual(queries.find(x=>x.sql.includes("SET status=$2")).params,[1,"queued"]);
});
test("fifth unsuccessful attempt fails terminally and remains auditable",async()=>{
  const {queries,db}=fake(4);
  const result=await processInvalidationBatch(db,1);
  assert.equal(result.failed,1);
  assert.deepEqual(queries.find(x=>x.sql.includes("SET status=$2")).params,[1,"failed"]);
});
test("invalid batch limits cannot execute database operations",async()=>{
  const db={async query(){throw new Error("should not query")}};
  await assert.rejects(processInvalidationBatch(db,50),/Invalid invalidation batch size/);
});
