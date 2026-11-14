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
    assert.equal(first.createdAt,t.toISOString(),
      "SQLite claim must preserve the exact source emission timestamp");
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
    assert.match(first.createdAt,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      "PostgreSQL claim must expose source created_at as normalized UTC ISO");
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

    // An open transaction must not let an expired lease pass its fencing
    // check merely because PostgreSQL NOW() is frozen at transaction start.
    const lateEvents=[
      {...event,eventKey:"pg:late-ack"},
      {...event,eventKey:"pg:late-fail"},
      {...event,eventKey:"pg:late-renew"},
    ];
    const lateWriter=await pool.connect();
    try{
      await lateWriter.query("BEGIN");
      for(const item of lateEvents)await emitPostgres(lateWriter,item);
      await lateWriter.query("COMMIT");
    }finally{lateWriter.release()}
    const lateClaims=await claimPostgres(pool,{
      workerId:"late-fence",batchSize:3,leaseMs:3000,
    });
    assert.equal(lateClaims.length,3);
    const lateTx=await pool.connect();
    try{
      await lateTx.query("BEGIN");
      const clock=(await lateTx.query("SELECT clock_timestamp() AS at")).rows[0]?.at;
      assert.ok(clock instanceof Date);
      const remaining=Date.parse(lateClaims[0].leaseUntil)-clock.getTime();
      assert.ok(remaining>0,"the test transaction must start before lease expiry");
      await lateTx.query("SELECT pg_sleep($1)",[(remaining+150)/1000]);
      assert.equal(await ackPostgres(
        lateTx,lateClaims[0].id,lateClaims[0].leaseOwner,lateClaims[0].leaseUntil,
      ),false,"late ACK must be fenced using wall-clock time");
      assert.equal(await failPostgres(
        lateTx,lateClaims[1].id,lateClaims[1].leaseOwner,lateClaims[1].leaseUntil,
        "expired",new Date(),
      ),false,"late NACK must be fenced using wall-clock time");
      assert.equal(await renewPostgres(
        lateTx,lateClaims[2].id,lateClaims[2].leaseOwner,lateClaims[2].leaseUntil,10_000,
      ),null,"an expired lease cannot be resurrected by renewal");
      await lateTx.query("ROLLBACK");
    }catch(error){
      try{await lateTx.query("ROLLBACK")}catch{}
      throw error;
    }finally{lateTx.release()}
    const reclaimed=await claimPostgres(pool,{
      workerId:"after-expiry",batchSize:3,leaseMs:3000,
    });
    assert.equal(reclaimed.length,3,"expired claims must become available to a new worker");
  }finally{
    if(pool)await pool.end();
    try{await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE')}catch{}
    await admin.end();
  }
});
