import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  SQLITE_OUTBOX_DDL, emitSqlite, claimSqlite, ackSqlite, failSqlite
} from "../dist/index.js";

const event={sourceSystem:"blockchain",eventKind:"trade_observed",
  eventKey:"solana:signature123:revision1",schemaVersion:"chain-trade-v1",
  payload:{wallet:"11111",source:"fixture"}};
test("actual SQLite: rollback, dedup, claim, lease expiration and ACK",()=>{
  const db=new Database(":memory:");
  try{
    db.exec(SQLITE_OUTBOX_DDL);
    db.exec("BEGIN IMMEDIATE");
    emitSqlite(db,event);
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox_events").get().n,0);
    db.exec("BEGIN IMMEDIATE");
    emitSqlite(db,event);
    emitSqlite(db,event);
    db.exec("COMMIT");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox_events").get().n,1);
    const now=new Date();
    const first=claimSqlite(db,{workerId:"workerA",batchSize:10,leaseMs:60000,now});
    assert.equal(first.length,1);
    assert.equal(claimSqlite(db,{workerId:"workerB",batchSize:10,leaseMs:60000,now}).length,0);
    assert.equal(ackSqlite(db,first[0].id,"workerB",first[0].leaseUntil,now),false);
    assert.equal(ackSqlite(db,first[0].id,"workerA",first[0].leaseUntil,now),true);
    assert.equal(ackSqlite(db,first[0].id,"workerA",first[0].leaseUntil,now),false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox_events WHERE processed_at IS NOT NULL").get().n,1);
  }finally{db.close()}
});

test("actual SQLite: transient failure retries after next_attempt_at",()=>{
  const db=new Database(":memory:");
  try{
    db.exec(SQLITE_OUTBOX_DDL);
    const now=new Date();
    const future=new Date(now.getTime()+120000);
    db.exec("BEGIN");
    emitSqlite(db,{...event,eventKey:"other"},now);
    db.exec("COMMIT");
    const claimed=claimSqlite(db,{workerId:"workerA",batchSize:1,leaseMs:60000,now});
    assert.equal(claimed.length,1);
    assert.equal(failSqlite(db,claimed[0].id,"workerA",claimed[0].leaseUntil,"transient",future,now,3),true);
    assert.equal(claimSqlite(db,{workerId:"workerB",batchSize:1,leaseMs:60000,now}).length,0);
    assert.equal(claimSqlite(db,{workerId:"workerB",batchSize:1,leaseMs:60000,now:new Date(future.getTime()+1)}).length,1);
  }finally{db.close()}
});

test("SQLite renewed lease fences stale ACK/NACK from same worker ID",()=>{
  const db=new Database(":memory:");
  try{
    db.exec(SQLITE_OUTBOX_DDL);
    const t=new Date("2026-10-18T00:00:00Z");
    const fresh=new Date(t.getTime()+2000);
    db.exec("BEGIN");
    emitSqlite(db,{...event,eventKey:"sqlite-fencing"},t);
    db.exec("COMMIT");
    const first=claimSqlite(db,{workerId:"reused-worker",batchSize:1,leaseMs:1000,now:t})[0];
    const second=claimSqlite(db,{workerId:"reused-worker",batchSize:1,leaseMs:1000,now:fresh})[0];
    assert.ok(first&&second);
    assert.notEqual(first.leaseUntil,second.leaseUntil);
    assert.equal(ackSqlite(db,first.id,first.leaseOwner,first.leaseUntil,fresh),false);
    assert.equal(failSqlite(db,first.id,first.leaseOwner,first.leaseUntil,"stale",fresh,fresh),false);
    assert.equal(ackSqlite(db,second.id,second.leaseOwner,second.leaseUntil,fresh),true);
  }finally{db.close()}
});
