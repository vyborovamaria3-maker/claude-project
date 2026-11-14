import test from "node:test";
import assert from "node:assert/strict";
import { readOutboxHealth, healthAlerts } from "../scripts/outbox-health.mjs";

const now=new Date("2026-11-05T00:00:00.000Z");

test("SQLite health snapshot is read-only and reports backlog, lag, retries and progress",async()=>{
  let sql="",args=[];
  const source={kind:"sqlite",connection:{prepare(value){sql=value;return {get(...values){args=values;return {
    pending:4,ready:2,leased:1,retry_delayed:1,retry_events:2,retry_attempts:5,
    dead_letter:1,max_attempts:4,oldest_pending_at:"2026-11-04T23:45:00.000Z",
    last_progress_at:"2026-11-04T23:59:30.000Z",
  }}}}}};
  const health=await readOutboxHealth(source,now);
  assert.equal(args.length,4);
  assert.ok(!/payload/i.test(sql));
  assert.match(sql,/FROM outbox_events/);
  assert.equal(health.pending,4);
  assert.equal(health.ready,2);
  assert.equal(health.leased,1);
  assert.equal(health.retryDelayed,1);
  assert.equal(health.retryEvents,2);
  assert.equal(health.retryAttempts,5);
  assert.equal(health.deadLetter,1);
  assert.equal(health.oldestPendingAgeMs,900_000);
  assert.equal(health.lastProgressAgeMs,30_000);
});

test("PostgreSQL health snapshot normalizes text counts and timestamps",async()=>{
  let query="",values=[];
  const source={kind:"pg",connection:{async query(sql,params){query=sql;values=params;return {rows:[{
    pending:"3",ready:"1",leased:"1",retry_delayed:"1",retry_events:"2",
    retry_attempts:"7",dead_letter:"0",max_attempts:"5",
    oldest_pending_at:new Date("2026-11-04T23:30:00.000Z"),
    last_progress_at:new Date("2026-11-04T23:59:00.000Z"),
  }]}}}};
  const health=await readOutboxHealth(source,now);
  assert.equal(values[0],now.toISOString());
  assert.ok(!/payload/i.test(query));
  assert.equal(health.pending,3);
  assert.equal(health.retryAttempts,7);
  assert.equal(health.oldestPendingAgeMs,1_800_000);
  assert.equal(health.lastProgressAgeMs,60_000);
});

test("empty source reports null lag/progress and zero counters",async()=>{
  const source={kind:"sqlite",connection:{prepare(){return {get(){return {
    pending:0,ready:0,leased:0,retry_delayed:0,retry_events:0,retry_attempts:0,
    dead_letter:0,max_attempts:null,oldest_pending_at:null,last_progress_at:null,
  }}}}}};
  const health=await readOutboxHealth(source,now);
  assert.equal(health.oldestPendingAgeMs,null);
  assert.equal(health.lastProgressAt,null);
  assert.equal(health.maxAttempts,0);
});

test("health alerts use conservative defaults and identify DLQ, old pending and retries",()=>{
  const alerts=healthAlerts({deadLetter:1,oldestPendingAgeMs:900_000,retryEvents:5});
  assert.deepEqual(alerts.map(x=>x.code),[
    "dead_letter_backlog","oldest_pending_age_exceeded","retry_backlog",
  ]);
  assert.deepEqual(healthAlerts({deadLetter:0,oldestPendingAgeMs:10,retryEvents:0}),[]);
});

test("invalid source, count, timestamp and threshold fail closed",async()=>{
  await assert.rejects(readOutboxHealth({kind:"pg",connection:{query:async()=>({rows:[{pending:"NaN"}]})}},now));
  await assert.rejects(readOutboxHealth({kind:"sqlite",connection:{prepare(){return {get(){return {
    pending:0,ready:0,leased:0,retry_delayed:0,retry_events:0,retry_attempts:0,
    dead_letter:0,max_attempts:0,oldest_pending_at:"not-a-date",last_progress_at:null,
  }}}}}},now));
  assert.throws(()=>healthAlerts({deadLetter:0,oldestPendingAgeMs:null,retryEvents:0},{pendingAgeWarnMs:1}));
});
