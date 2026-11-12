import test from "node:test";
import assert from "node:assert/strict";
import {
  validateOutboxEvent,POSTGRES_OUTBOX_DDL,SQLITE_OUTBOX_DDL,
  emitPostgres,claimPostgres,ackPostgres,failPostgres,
  emitSqlite,claimSqlite,ackSqlite,failSqlite,
} from "../dist/index.js";

const E={sourceSystem:"tg",eventKind:"message_observed",eventKey:"tg:-100:42:v1",
         schemaVersion:"tg-message-v1",payload:{sourceId:"-100",messageId:"42"}};

test("event requires stable versioned key and bounded JSON",()=>{
  assert.doesNotThrow(()=>validateOutboxEvent(E));
  assert.throws(()=>validateOutboxEvent({...E,eventKey:" "}),/eventKey/);
  assert.throws(()=>validateOutboxEvent({...E,payload:{n:BigInt(1)}}),/JSON/);
  assert.match(POSTGRES_OUTBOX_DDL,/lease_until/);
  assert.match(SQLITE_OUTBOX_DDL,/lease_until/);
});

test("Postgres emit never commits independently; duplicate key handled at DB",async()=>{
  const calls=[];
  await emitPostgres({query:async(sql,values)=>{calls.push({sql,values});return{rows:[]}}},E);
  assert.equal(calls.length,1);
  assert.match(calls[0].sql,/ON CONFLICT/);
  assert.match(calls[0].sql,/created_at/);
  assert.match(calls[0].sql,/clock_timestamp\(\)/,
    "PostgreSQL emittedAt must use actual outbox insertion time, not transaction-start NOW()");
  assert.equal(calls[0].values[2],E.eventKey);
  assert.ok(!calls[0].sql.includes("COMMIT"));
});

test("Postgres claim uses locked transaction, then release",async()=>{
  const calls=[];
  const pool={connect:async()=>({
    query:async(sql)=>{calls.push(sql);return{rows:sql.includes("RETURNING o.*")?[{
      id:"2",source_system:"tg",event_kind:E.eventKind,event_key:E.eventKey,
      schema_version:E.schemaVersion,payload:E.payload,created_at:"2026-10-18T00:00:01.234Z",
      attempts:0,lease_owner:"w",lease_until:"2026-10-18T00:10:00Z"
    }]:[]}},
    release:()=>calls.push("RELEASE"),
  })};
  const rows=await claimPostgres(pool,{workerId:"w",batchSize:10,leaseMs:10000,now:new Date("2026-10-18T00:00:00Z")});
  assert.equal(rows.length,1);assert.equal(rows[0].eventKey,E.eventKey);
  assert.equal(rows[0].createdAt,"2026-10-18T00:00:01.234Z",
    "claim must expose immutable source outbox created_at as an ISO timestamp");
  assert.deepEqual(calls.slice(0,1),["BEGIN"]);
  assert.ok(calls.some(x=>x.includes("FOR UPDATE SKIP LOCKED")));
  assert.deepEqual(calls.slice(-2),["COMMIT","RELEASE"]);
});

test("Postgres claims use the database statement clock unless a deterministic override is supplied",async()=>{
  const calls=[];
  const pool={connect:async()=>({
    query:async(sql,params)=>{calls.push({sql,params});return{rows:[]}},
    release:()=>calls.push({sql:"RELEASE"}),
  })};
  await claimPostgres(pool,{workerId:"db-clock",batchSize:1,leaseMs:5000});
  const claim=calls.find(call=>call.sql.includes("RETURNING o.*"));
  assert.ok(claim);
  assert.equal(claim.params[0],null,"production claims must not depend on the host wall clock");
  assert.equal(claim.params[3],5000);
  assert.match(claim.sql,/next_attempt_at <= COALESCE\(\$1::timestamptz, statement_timestamp\(\)\)/);
  assert.match(claim.sql,/lease_until IS NULL OR lease_until <= COALESCE\(\$1::timestamptz, statement_timestamp\(\)\)/);
  assert.match(claim.sql,/lease_until=DATE_TRUNC\('milliseconds', COALESCE\(\$1::timestamptz, statement_timestamp\(\)\)\)/);
});

test("Postgres claim keeps an explicit deterministic clock override",async()=>{
  const calls=[];
  const pool={connect:async()=>({
    query:async(sql,params)=>{calls.push({sql,params});return{rows:[]}},
    release:()=>{},
  })};
  const now=new Date("2026-10-18T00:00:00.000Z");
  await claimPostgres(pool,{workerId:"fixture-clock",batchSize:1,leaseMs:7000,now});
  const claim=calls.find(call=>call.sql.includes("RETURNING o.*"));
  assert.equal(claim.params[0],now.toISOString());
  assert.equal(claim.params[3],7000);
});

test("Postgres ACK and failure require lease owner",async()=>{
  const calls=[];
  const client={query:async(sql,params)=>{calls.push({sql,params});return{rows:[{id:"7"}]}}};
  assert.equal(await ackPostgres(client,"7","w","2026-10-18T00:10:00Z"),true);
  assert.equal(await failPostgres(client,"7","w","2026-10-18T00:10:00Z","network",new Date()),true);
  assert.equal(calls[1].params[6],null,"explicit nextAttemptAt remains available for deterministic callers");
  assert.equal(await failPostgres(client,"7","w","2026-10-18T00:10:00Z","network",new Date("2026-10-18T00:00:00Z"),12,30000),true);
  assert.equal(calls[2].params[6],30000);
  assert.match(calls[2].sql,/DATE_TRUNC\('milliseconds', statement_timestamp\(\)\)/);
  assert.match(calls[0].sql,/processed_at=clock_timestamp\(\)/);
  assert.match(calls[0].sql,/lease_until>clock_timestamp\(\)/);
  assert.match(calls[1].sql,/dead_lettered_at=CASE WHEN attempts\+1 >= \$5 THEN clock_timestamp\(\)/);
  assert.match(calls[1].sql,/lease_until>clock_timestamp\(\)/);
  assert.ok(calls.every(x=>x.sql.includes("lease_owner=$2")));
});

function fakeSqlite() {
  const sql=[];
  return {
    sql,
    exec:(q)=>{sql.push(q)},
    prepare:(q)=>({
      all:()=>[{id:1,source_system:"tg",event_kind:E.eventKind,event_key:E.eventKey,
        schema_version:E.schemaVersion,payload:JSON.stringify(E.payload),
        created_at:"2026-10-18T00:00:02.345Z",attempts:0}],
      get:()=>undefined,
      run:(...params)=>{sql.push({q,params});return {changes:1}}
    })
  };
}
test("SQLite emit is caller-owned, claim locks and ACK fenced to owner",()=>{
  const db=fakeSqlite();
  emitSqlite(db,E,new Date("2026-10-18T00:00:00Z"));
  assert.equal(db.sql.filter(x=>x==="COMMIT").length,0);
  const rows=claimSqlite(db,{workerId:"w",batchSize:10,leaseMs:10000,now:new Date("2026-10-18T00:00:00Z")});
  assert.equal(rows[0].id,"1");
  assert.equal(rows[0].createdAt,"2026-10-18T00:00:02.345Z");
  assert.ok(db.sql.includes("BEGIN IMMEDIATE"));
  assert.ok(db.sql.includes("COMMIT"));
  assert.equal(ackSqlite(db,"1","w",rows[0].leaseUntil),true);
  assert.equal(failSqlite(db,"1","w",rows[0].leaseUntil,"bad",new Date()),true);
  assert.ok(db.sql.some(x=>typeof x==="object"&&x.q.includes("lease_owner=?")));
});


test("Postgres and SQLite claims reject rows without a valid immutable created_at",async()=>{
  const pgPool={connect:async()=>({
    query:async(sql)=>({rows:sql.includes("RETURNING o.*")?[{
      id:"3",source_system:"tg",event_kind:E.eventKind,event_key:E.eventKey,
      schema_version:E.schemaVersion,payload:E.payload,attempts:0,lease_owner:"w",
      lease_until:"2026-10-18T00:10:00Z",
    }]:[]}),
    release:()=>{},
  })};
  const pgCalls=[];
  const trackedPgPool={connect:async()=>({
    query:async(sql)=>{pgCalls.push(sql);return sql.includes("RETURNING o.*")?[{
      id:"3",source_system:"tg",event_kind:E.eventKind,event_key:E.eventKey,
      schema_version:E.schemaVersion,payload:E.payload,attempts:0,lease_owner:"w",
      lease_until:"2026-10-18T00:10:00Z",
    }]:{rows:[]}},
    release:()=>pgCalls.push("RELEASE"),
  })};
  await assert.rejects(
    claimPostgres(trackedPgPool,{workerId:"w",batchSize:1,leaseMs:5000,now:new Date("2026-10-18T00:00:00Z")}),
    /created_at timestamp/,
  );
  assert.ok(pgCalls.includes("ROLLBACK"),
    "malformed claim metadata must roll back before a lease is committed");
  const db=fakeSqlite();
  const prepare=db.prepare;
  db.prepare=(sql)=>sql.includes("SELECT * FROM outbox_events")
    ? {all:()=>[{id:1,source_system:"tg",event_kind:E.eventKind,event_key:E.eventKey,
        schema_version:E.schemaVersion,payload:JSON.stringify(E.payload),attempts:0}],
       get:()=>undefined,run:()=>({changes:1})}
    : prepare(sql);
  assert.throws(
    ()=>claimSqlite(db,{workerId:"w",batchSize:1,leaseMs:5000,now:new Date("2026-10-18T00:00:00Z")}),
    /created_at timestamp/,
  );
});
