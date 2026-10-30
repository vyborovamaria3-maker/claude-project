import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {SQLITE_OUTBOX_DDL} from "@claude-project/event-outbox";
import {outboxStatus} from "../scripts/etl-connections.mjs";
import {classifyOutboxHealth,parseArguments} from "../scripts/supervise.mjs";

const now=new Date("2026-10-30T20:00:00.000Z");

function sqliteFixture(){
  const db=new Database(":memory:");
  db.exec(SQLITE_OUTBOX_DDL);
  const insert=db.prepare(`INSERT INTO outbox_events
    (source_system,event_kind,event_key,schema_version,payload,created_at,
     processed_at,lease_owner,lease_until,next_attempt_at,attempts,dead_lettered_at,last_error)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const row=(key,created,processed,owner,lease,next,attempts,dead,schema="v1")=>{
    insert.run("x","tweet_observed",key,schema,"{}",created,processed,owner,lease,next,attempts,dead,null);
  };
  row("ready","2026-10-30T19:50:00.000Z",null,null,null,"2026-10-30T19:50:00.000Z",0,null);
  row("leased","2026-10-30T19:55:00.000Z",null,"worker","2026-10-30T20:05:00.000Z","2026-10-30T19:55:00.000Z",2,null,"v2");
  row("dead","2026-10-30T19:30:00.000Z",null,null,null,"2026-10-30T19:40:00.000Z",5,"2026-10-30T19:41:00.000Z");
  row("done","2026-10-30T19:00:00.000Z","2026-10-30T19:05:00.000Z",null,null,"2026-10-30T19:00:00.000Z",1,null);
  return db;
}

test("SQLite outbox health is read-only and reports backlog, retry, DLQ and progress clocks",async()=>{
  const db=sqliteFixture();
  try{
    const before=db.prepare("SELECT COUNT(*) AS n FROM outbox_events").get().n;
    const health=await outboxStatus({kind:"sqlite",connection:db},now);
    const after=db.prepare("SELECT COUNT(*) AS n FROM outbox_events").get().n;
    assert.equal(after,before,"health snapshots must not mutate or claim events");
    assert.deepEqual(health,{
      pending:2,ready:1,leased:1,retryCount:1,retryAttemptsTotal:2,retryDelayed:0,deadLetter:1,
      schemaVersionSkewKinds:1,
      oldestPendingAt:"2026-10-30T19:50:00.000Z",oldestPendingAgeMs:600000,
      lastProgressAt:"2026-10-30T19:05:00.000Z",lastProgressAgeMs:3300000,
      maxAttempts:2,
    });
  }finally{db.close();}
});

test("PostgreSQL health maps native timestamps and bigint counters without exposing payloads",async()=>{
  let calls=0;
  const connection={query:async(sql)=>{
    calls++;
    if(sql.includes("to_regclass"))return {rows:[{present:true}]};
    return {rows:[{
      pending:"3",ready:"2",leased:"1",retry_count:"2",retry_attempts_total:"6",
      retry_delayed:"1",dead_letter:"0",schema_version_skew_kinds:"1",
      oldest_pending_at:new Date("2026-10-30T19:40:00.000Z"),
      last_progress_at:new Date("2026-10-30T19:58:00.000Z"),max_attempts:"4",
    }]};
  }};
  const health=await outboxStatus({kind:"pg",connection},now);
  assert.equal(calls,2);
  assert.equal(health.pending,3);
  assert.equal(health.ready,2);
  assert.equal(health.leased,1);
  assert.equal(health.retryCount,2);
  assert.equal(health.retryAttemptsTotal,6);
  assert.equal(health.retryDelayed,1);
  assert.equal(health.deadLetter,0);
  assert.equal(health.schemaVersionSkewKinds,1);
  assert.equal(health.oldestPendingAgeMs,1200000);
  assert.equal(health.lastProgressAgeMs,120000);
  assert.equal(health.maxAttempts,4);
  assert.equal(JSON.stringify(health).includes("payload"),false);
});

test("health alerts use conservative configurable thresholds and remain machine-readable",()=>{
  const health={
    pending:2,deadLetter:1,maxAttempts:5,oldestPendingAgeMs:600001,
  };
  assert.deepEqual(classifyOutboxHealth(health,{alertOldestPendingMs:300000,maxFailures:5}),[
    "dead_letter_events_present","oldest_pending_age_exceeded","pending_retry_threshold_exceeded",
  ]);
  assert.deepEqual(classifyOutboxHealth(health,{alertOldestPendingMs:0,maxFailures:6}),[
    "dead_letter_events_present",
  ]);
  assert.throws(()=>classifyOutboxHealth({...health,pending:-1}),/health snapshot/);
});

test("supervisor health options are bounded and zero disables only the lag alert",()=>{
  const parsed=parseArguments(["--sources","x,tg","--health-interval-ms","10000","--alert-oldest-pending-ms","0"]);
  assert.equal(parsed.healthIntervalMs,10000);
  assert.equal(parsed.alertOldestPendingMs,0);
  assert.throws(()=>parseArguments(["--sources","x","--health-interval-ms","0"]),/invalid supervisor numeric option/);
  assert.throws(()=>parseArguments(["--sources","x","--alert-oldest-pending-ms","86400001"]),/invalid supervisor numeric option/);
});
