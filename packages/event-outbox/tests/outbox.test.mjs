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
  assert.equal(calls[0].values[2],E.eventKey);
  assert.ok(!calls[0].sql.includes("COMMIT"));
});

test("Postgres claim uses locked transaction, then release",async()=>{
  const calls=[];
  const pool={connect:async()=>({
    query:async(sql)=>{calls.push(sql);return{rows:sql.includes("RETURNING o.*")?[{
      id:"2",source_system:"tg",event_kind:E.eventKind,event_key:E.eventKey,
      schema_version:E.schemaVersion,payload:E.payload,attempts:0,lease_owner:"w",
      lease_until:"2026-10-18T00:10:00Z"
    }]:[]}},
    release:()=>calls.push("RELEASE"),
  })};
  const rows=await claimPostgres(pool,{workerId:"w",batchSize:10,leaseMs:10000,now:new Date("2026-10-18T00:00:00Z")});
  assert.equal(rows.length,1);assert.equal(rows[0].eventKey,E.eventKey);
  assert.deepEqual(calls.slice(0,1),["BEGIN"]);
  assert.ok(calls.some(x=>x.includes("FOR UPDATE SKIP LOCKED")));
  assert.deepEqual(calls.slice(-2),["COMMIT","RELEASE"]);
});

test("Postgres ACK and failure require lease owner",async()=>{
  const calls=[];
  const client={query:async(sql,params)=>{calls.push({sql,params});return{rows:[{id:"7"}]}}};
  assert.equal(await ackPostgres(client,"7","w"),true);
  assert.equal(await failPostgres(client,"7","w","network",new Date()),true);
  assert.ok(calls.every(x=>x.sql.includes("lease_owner=$2")));
});

function fakeSqlite() {
  const sql=[];
  return {
    sql,
    exec:(q)=>{sql.push(q)},
    prepare:(q)=>({
      all:()=>[{id:1,source_system:"tg",event_kind:E.eventKind,event_key:E.eventKey,
        schema_version:E.schemaVersion,payload:JSON.stringify(E.payload),attempts:0}],
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
  assert.ok(db.sql.includes("BEGIN IMMEDIATE"));
  assert.ok(db.sql.includes("COMMIT"));
  assert.equal(ackSqlite(db,"1","w"),true);
  assert.equal(failSqlite(db,"1","w","bad",new Date()),true);
  assert.ok(db.sql.some(x=>typeof x==="object"&&x.q.includes("lease_owner=?")));
});
