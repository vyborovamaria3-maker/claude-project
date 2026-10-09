import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { executeMonitoringCycle } from "../lib/trade/graph-monitoring";
function fake(locked=true, fail=false) {
  const history=new Set<string>(), events=new Set<string>();
  const calls: string[]=[];
  const query=async (sql: string, values: unknown[]=[]) => {
    calls.push(sql);
    if(sql.includes("pg_try_advisory")) return {rows:[{locked}],rowCount:1};
    if(sql.includes("FROM twitter_tweets")) return {rows:Array.from({length:20},(_,i)=>({tweet_id:String(i),handle:String(i),posted_at:"9500",entities:["token:a"],influence:"100"})),rowCount:20};
    if(fail) throw new Error("database write failed");
    const set=sql.includes("INSERT INTO graph_signal_history")?history:events;
    const key=JSON.stringify(values.slice(0,3));
    const added=!set.has(key); set.add(key); return {rows:added?[{}]:[],rowCount:added?1:0};
  };
  return {client:{query} as unknown as Pick<PoolClient,"query">,history,events,calls};
}
test("busy transaction lock skips all reads and writes",async()=>{
  const db=fake(false); const r=await executeMonitoringCycle(db.client,10500,1000);
  assert.equal(r.acquired,false); assert.equal(db.calls.length,1);
});
test("same completed window is idempotent; next window persists separately",async()=>{
  const db=fake(); const first=await executeMonitoringCycle(db.client,10500,1000);
  assert.equal(first.bucketAt,10000); assert.equal(first.signals,1); assert.equal(first.events,1);
  const retry=await executeMonitoringCycle(db.client,10900,1000);
  assert.equal(retry.signals,0); assert.equal(retry.events,0);
  await executeMonitoringCycle(db.client,11500,2000);
  assert.equal(db.history.size,2);
});
test("write failures propagate to transaction wrapper",async()=>{
  await assert.rejects(executeMonitoringCycle(fake(true,true).client,10500,1000),/database write failed/);
});
test("invalid options do not acquire a lock",async()=>{
  const db=fake(); await assert.rejects(executeMonitoringCycle(db.client,NaN)); assert.equal(db.calls.length,0);
});
