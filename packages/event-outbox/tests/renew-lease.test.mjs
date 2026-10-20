import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import Database from "better-sqlite3";
import {
  SQLITE_OUTBOX_DDL, POSTGRES_OUTBOX_DDL,
  emitSqlite, claimSqlite, renewSqlite, ackSqlite, failSqlite,
  emitPostgres, claimPostgres, renewPostgres, ackPostgres, failPostgres,
} from "../dist/index.js";

const sample={
  sourceSystem:"blockchain",eventKind:"wallet_transaction_observed",
  eventKey:"fixture:renew:1",schemaVersion:"fixture-v1",payload:{fixture:true},
};

test("SQLite renewal fences original token, extends expiration and refuses dead claims",()=>{
  const db=new Database(":memory:");
  try{
    db.exec(SQLITE_OUTBOX_DDL);
    const t=new Date("2026-10-20T00:00:00Z");
    db.transaction(()=>emitSqlite(db,sample,t))();
    const first=claimSqlite(db,{
      workerId:"local-supervisor",batchSize:1,leaseMs:1000,now:t,
    })[0];
    assert.ok(first);
    const next=renewSqlite(db,first.id,first.leaseOwner,first.leaseUntil,1000,
      new Date(t.getTime()+500));
    assert.equal(next,new Date(t.getTime()+1500).toISOString());
    assert.equal(ackSqlite(db,first.id,first.leaseOwner,first.leaseUntil,
      new Date(t.getTime()+600)),false,"stale fencing token must fail");
    assert.equal(failSqlite(db,first.id,first.leaseOwner,first.leaseUntil,
      "fixture",new Date(t.getTime()+1800),new Date(t.getTime()+600)),false);
    assert.equal(renewSqlite(db,first.id,"foreign",next,1000,new Date(t.getTime()+650)),null);
    assert.equal(renewSqlite(db,first.id,first.leaseOwner,first.leaseUntil,
      1000,new Date(t.getTime()+650)),null,"previous renewal token must fail");
    assert.equal(claimSqlite(db,{
      workerId:"other",batchSize:1,leaseMs:1000,now:new Date(t.getTime()+1100),
    }).length,0,"renewed lease blocks competing claim");
    assert.equal(ackSqlite(db,first.id,first.leaseOwner,next,
      new Date(t.getTime()+1200)),true);
    assert.equal(renewSqlite(db,first.id,first.leaseOwner,next,1000,
      new Date(t.getTime()+1250)),null,"processed event cannot be renewed");
    assert.throws(()=>renewSqlite(db,first.id,first.leaseOwner,next,0),RangeError);
  }finally{db.close()}
});

test("PostgreSQL renewal uses DB time and fences original ACK/NACK",{
  skip:!process.env.OUTBOX_TEST_PG_URL,
},async()=>{
  const url=process.env.OUTBOX_TEST_PG_URL;
  const schema="renew_"+randomBytes(6).toString("hex");
  const admin=new pg.Client({connectionString:url});
  let pool;
  await admin.connect();
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');
    await admin.query('SET search_path TO "'+schema+'"');
    await admin.query(POSTGRES_OUTBOX_DDL);
    pool=new pg.Pool({connectionString:url,options:"-c search_path="+schema,max:3});
    const event={...sample,sourceSystem:"x",eventKey:"pg:renew"};
    const writer=await pool.connect();
    try{
      await writer.query("BEGIN");
      await emitPostgres(writer,event);
      await writer.query("COMMIT");
    }finally{writer.release()}
    const first=(await claimPostgres(pool,{
      workerId:"local-supervisor",batchSize:1,leaseMs:2000,
    }))[0];
    assert.ok(first);
    const next=await renewPostgres(
      pool,first.id,first.leaseOwner,first.leaseUntil,10_000,
    );
    assert.ok(next && Date.parse(next)>Date.parse(first.leaseUntil));
    assert.equal(await ackPostgres(pool,first.id,first.leaseOwner,first.leaseUntil),false);
    assert.equal(await failPostgres(pool,first.id,first.leaseOwner,first.leaseUntil,
      "stale",new Date()),false);
    assert.equal(await renewPostgres(pool,first.id,first.leaseOwner,
      first.leaseUntil,10_000),null);
    assert.equal(await renewPostgres(pool,first.id,"different",next,10_000),null);
    assert.equal((await claimPostgres(pool,{
      workerId:"competitor",batchSize:1,leaseMs:1000,
    })).length,0);
    assert.equal(await ackPostgres(pool,first.id,first.leaseOwner,next),true);
    assert.equal(await renewPostgres(pool,first.id,first.leaseOwner,next,10_000),null);
  }finally{
    if(pool)await pool.end();
    try{await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE')}catch{}
    await admin.end();
  }
});
