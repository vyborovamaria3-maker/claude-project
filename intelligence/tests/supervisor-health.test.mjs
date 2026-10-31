import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import pg from "pg";
import Database from "better-sqlite3";
import {SQLITE_OUTBOX_DDL,POSTGRES_OUTBOX_DDL} from "@claude-project/event-outbox";
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
  const connection={query:async(sql,params)=>{
    calls++;
    if(sql.includes("to_regclass"))return {rows:[{present:true}]};
    assert.match(sql,/COALESCE\(\$1::timestamptz, statement_timestamp\(\)\)/);
    assert.deepEqual(params,[now.toISOString()]);
    return {rows:[{
      pending:"3",ready:"2",leased:"1",retry_count:"2",retry_attempts_total:"6",
      retry_delayed:"1",dead_letter:"0",schema_version_skew_kinds:"1",
      oldest_pending_at:new Date("2026-10-30T19:40:00.000Z"),
      last_progress_at:new Date("2026-10-30T19:58:00.000Z"),max_attempts:"4",
      measured_at:now,
    }]};
  }};
  const health=await outboxStatus({kind:"pg",connection},now);
  assert.equal(calls,2);
  assert.equal(health.measuredAt,now.toISOString());
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

const postgresUrl=process.env.INTELLIGENCE_TEST_DB_URL;
test("PostgreSQL health uses the database clock when the application host is one minute behind",{
  skip:!postgresUrl,
},async()=>{
  const schema="health_clock_"+randomBytes(6).toString("hex");
  const admin=new pg.Client({connectionString:postgresUrl});
  let pool;
  let schemaCreated=false;
  await admin.connect();
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');
    schemaCreated=true;
    pool=new pg.Pool({
      connectionString:postgresUrl,
      options:"-c search_path="+schema,
      max:2,
    });
    await pool.query(POSTGRES_OUTBOX_DDL);
    await pool.query(`INSERT INTO outbox_events
      (source_system,event_kind,event_key,schema_version,payload)
      VALUES ('x','tweet_observed','clock-skew','v1','{}'::jsonb)`);
    await pool.query(`UPDATE outbox_events SET
      created_at=statement_timestamp()-interval '5 minutes 30 seconds',
      next_attempt_at=statement_timestamp()-interval '30 seconds'`);

    const NativeDate=globalThis.Date;
    class SkewedDate extends NativeDate{
      constructor(...args){
        if(args.length===0)super(NativeDate.now()-60_000);
        else super(...args);
      }
      static now(){return NativeDate.now()-60_000;}
    }
    globalThis.Date=SkewedDate;
    let health;
    try{
      health=await outboxStatus({kind:"pg",connection:pool});
    }finally{
      globalThis.Date=NativeDate;
    }

    assert.equal(health.pending,1);
    assert.equal(health.ready,1,"DB time must classify a due event as ready despite host clock skew");
    assert.ok(health.oldestPendingAgeMs>=330_000&&health.oldestPendingAgeMs<360_000,
      "oldest-pending age must be calculated from the PostgreSQL observation time");
    assert.deepEqual(classifyOutboxHealth(health,{
      alertOldestPendingMs:300_000,maxFailures:5,
    }),["oldest_pending_age_exceeded"]);
  }finally{
    await pool?.end();
    if(schemaCreated){
      try{await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE')}catch{}
    }
    await admin.end();
  }
});

test("health alerts use conservative configurable thresholds and remain machine-readable",()=>{
  const health={
    pending:2,deadLetter:1,maxAttempts:5,schemaVersionSkewKinds:1,oldestPendingAgeMs:600001,
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
