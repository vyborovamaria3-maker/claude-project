import test from "node:test";
import assert from "node:assert/strict";
import {processInvalidationBatch} from "../dist/index.js";
const token="solana:So11111111111111111111111111111111111111112";

function missingDayFake(attempts=0){
  const queries=[];
  const db={async query(sql,params){
    queries.push({sql,params});
    if(sql.includes("FROM analytics_invalidation_queue")&&sql.includes("FOR UPDATE SKIP LOCKED"))
      return {rows:[{invalidation_id:"1",canonical_token_id:token,source_system:"tg",
        event_kind:"token_links_invalidated",event_key:"test-event",attempts,next_day:null}]};
    if(sql.includes("FROM intelligence_inbox origin"))return {rows:[{day:null}]};
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
  const {queries,db}=missingDayFake(0);
  const result=await processInvalidationBatch(db,1);
  assert.equal(result.retried,1);assert.equal(result.completed,0);
  assert.ok(queries.some(x=>x.sql.includes("next_attempt_at<=clock_timestamp()")));
  assert.ok(queries.some(x=>x.sql.includes("LEAST(300,5*power(2")));
  assert.ok(queries.some(x=>x.sql.includes("ROLLBACK TO SAVEPOINT")));
  assert.ok(queries.some(x=>x.sql.includes("INSERT INTO analytics_invalidation_log")));
  assert.deepEqual(queries.find(x=>x.sql.includes("SET status=$2")).params,[1,"queued"]);
});

test("fifth unsuccessful attempt fails terminally and remains auditable",async()=>{
  const {queries,db}=missingDayFake(4);
  const result=await processInvalidationBatch(db,1);
  assert.equal(result.failed,1);
  assert.deepEqual(queries.find(x=>x.sql.includes("SET status=$2")).params,[1,"failed"]);
});

test("historical invalidation recomputes every existing later snapshot in bounded chunks",async()=>{
  const days=Array.from({length:33},(_,i)=>{
    const date=new Date(Date.UTC(2026,9,20+i));
    return date.toISOString().slice(0,10);
  });
  const queries=[];
  let claimed=true;
  const db={async query(sql,params){
    queries.push({sql,params});
    if(sql.includes("FROM analytics_invalidation_queue")&&sql.includes("FOR UPDATE SKIP LOCKED")){
      if(!claimed)return {rows:[]};
      claimed=false;
      return {rows:[{invalidation_id:"7",canonical_token_id:token,source_system:"x",
        event_kind:"tweet_edited",event_key:"revision-2",attempts:0,next_day:null}]};
    }
    if(sql.includes("FROM intelligence_inbox origin"))return {rows:[{day:"2026-10-20"}]};
    if(sql.includes("FROM token_daily_cross_platform"))return {rows:days.map(day=>({day}))};
    if(sql.includes("SELECT clock_timestamp() AS at"))return {rows:[{at:"2026-12-01T00:00:00.000Z"}]};
    return {rows:[]};
  }};
  const refreshed=[];
  const result=await processInvalidationBatch(db,1,{
    maxDaysPerJob:31,
    refreshSnapshot:async(_tx,_token,day,asOf)=>{refreshed.push({day,asOf});},
  });
  assert.equal(result.continued,1);
  assert.equal(result.completed,0);
  assert.equal(refreshed.length,31);
  assert.equal(refreshed[0].day,"2026-10-20");
  assert.equal(refreshed.at(-1).day,"2026-11-19");
  assert.ok(refreshed.every(item=>item.asOf==="2026-12-01T00:00:00.000Z"));
  const continuation=queries.find(x=>x.sql.includes("next_day=$2::date+1"));
  assert.deepEqual(continuation.params,[7,"2026-11-19"]);
  assert.ok(queries.some(x=>x.sql.includes("INSERT INTO analytics_invalidation_log")&&x.sql.includes("'queued'")));
});

test("invalid batch and chunk limits cannot execute database operations",async()=>{
  const db={async query(){throw new Error("should not query")}};
  await assert.rejects(processInvalidationBatch(db,50),/Invalid invalidation batch size/);
  await assert.rejects(processInvalidationBatch(db,1,{maxDaysPerJob:0}),/Invalid invalidation day chunk size/);
});
