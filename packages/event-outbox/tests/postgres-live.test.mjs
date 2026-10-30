import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {
  POSTGRES_OUTBOX_DDL,emitPostgres,claimPostgres,ackPostgres,failPostgres
} from "../dist/index.js";

const url=process.env.OUTBOX_TEST_PG_URL;
const event={sourceSystem:"x",eventKind:"tweet_seen",eventKey:"tweet:999:v1",
  schemaVersion:"x-v1",payload:{tweetId:"999"}};
test("actual PostgreSQL: transaction rollback, dedup and fenced ACK",{skip:!url},async()=>{
  const pool=new pg.Pool({connectionString:url});
  try{
    await pool.query(POSTGRES_OUTBOX_DDL);
    const tx=await pool.connect();
    try{
      await tx.query("BEGIN");
      await emitPostgres(tx,event);
      await tx.query("ROLLBACK");
    }finally{tx.release()}
    assert.equal(Number((await pool.query("SELECT COUNT(*) AS n FROM outbox_events")).rows[0].n),0);
    const writer=await pool.connect();
    try{
      await writer.query("BEGIN");
      await emitPostgres(writer,event);
      await emitPostgres(writer,event);
      await writer.query("COMMIT");
    }finally{writer.release()}
    assert.equal(Number((await pool.query("SELECT COUNT(*) AS n FROM outbox_events")).rows[0].n),1);
    const now=new Date();
    const rows=await claimPostgres(pool,{workerId:"workerA",batchSize:5,leaseMs:60000});
    assert.equal(rows.length,1);
    assert.equal(rows[0].eventKey,event.eventKey);
    assert.equal((await claimPostgres(pool,{workerId:"workerB",batchSize:5,leaseMs:60000,now})).length,0);
    const client=await pool.connect();
    try{
      assert.equal(await ackPostgres(client,rows[0].id,"workerB",rows[0].leaseUntil),false);
      assert.equal(await ackPostgres(client,rows[0].id,"workerA",rows[0].leaseUntil),true);
      assert.equal(await ackPostgres(client,rows[0].id,"workerA",rows[0].leaseUntil),false);
    }finally{client.release()}
  }finally{await pool.end()}
});

test("actual PostgreSQL: DB-clock claim recovers an event when the application clock is stale",{skip:!url},async()=>{
  const pool=new pg.Pool({connectionString:url});
  const schema="db_clock_"+Math.random().toString(16).slice(2);
  const admin=new pg.Client({connectionString:url});
  await admin.connect();
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');
    await admin.query('SET search_path TO "'+schema+'"');
    await admin.query(POSTGRES_OUTBOX_DDL);
    await pool.end();
    const isolated=new pg.Pool({connectionString:url,options:"-c search_path="+schema,max:2});
    try{
      await emitPostgres(isolated,{...event,eventKey:"tweet:db-clock"});
      const dbNow=(await isolated.query("SELECT statement_timestamp() AS now")).rows[0].now;
      const staleNow=new Date(dbNow.getTime()-60_000);
      const stale=await claimPostgres(isolated,{
        workerId:"stale-host-clock",batchSize:1,leaseMs:60_000,now:staleNow,
      });
      assert.equal(stale.length,0,"an explicitly stale host timestamp must not make a future queue row ready");
      const claimed=await claimPostgres(isolated,{
        workerId:"database-clock",batchSize:1,leaseMs:60_000,
      });
      assert.equal(claimed.length,1,"the default database-clock path must claim the just-inserted event");
      assert.equal(await ackPostgres(isolated,claimed[0].id,"database-clock",claimed[0].leaseUntil),true);
    }finally{await isolated.end();}
  }finally{
    try{await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE')}catch{}
    await admin.end();
  }
});

test("actual PostgreSQL: failure postpones claim, retries with durable error",{skip:!url},async()=>{
  const pool=new pg.Pool({connectionString:url});
  try {
    await pool.query(POSTGRES_OUTBOX_DDL);
    const tx=await pool.connect();
    try {
      await tx.query("BEGIN");
      await emitPostgres(tx,{...event,eventKey:"tweet:1000:v1"});
      await tx.query("COMMIT");
    }finally{tx.release()}
    const now=new Date();
    const claimed=await claimPostgres(pool,{workerId:"workerA",batchSize:10,leaseMs:60000});
    assert.equal(claimed.length,1);
    const client=await pool.connect();
    try {
      assert.equal(await failPostgres(client,claimed[0].id,"workerA",claimed[0].leaseUntil,"fixture_transient",
        new Date(now.getTime()+120000)),true);
    }finally{client.release()}
    assert.equal((await claimPostgres(pool,{workerId:"workerB",batchSize:10,leaseMs:60000})).length,0);
    const saved=await pool.query("SELECT attempts,last_error FROM outbox_events WHERE event_key=$1",["tweet:1000:v1"]);
    assert.equal(saved.rows[0].attempts,1);
    assert.equal(saved.rows[0].last_error,"fixture_transient");
  }finally{await pool.end()}
});

test("PostgreSQL renewed lease fences stale ACK/NACK from same worker ID",{skip:!url},async()=>{
  const pool=new pg.Pool({connectionString:url});
  try {
    await pool.query(POSTGRES_OUTBOX_DDL);
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      await emitPostgres(client,{...event,eventKey:"pg-reused-worker-fencing"});
      await client.query("COMMIT");
    }finally{client.release()}
    // A just-committed server NOW() can be slightly ahead of the Node clock.
    // Make this fixture due deterministically; do not change production claim semantics.
    await pool.query("UPDATE outbox_events SET next_attempt_at=NOW() - interval '1 second' WHERE event_key=$1",["pg-reused-worker-fencing"]);
    const first=(await claimPostgres(pool,{workerId:"reused-worker",batchSize:1,leaseMs:10000,now:new Date()}))[0];
    assert.ok(first);
    await pool.query("UPDATE outbox_events SET lease_until=NOW() - interval '1 second' WHERE id=$1",[first.id]);
    const second=(await claimPostgres(pool,{workerId:"reused-worker",batchSize:1,leaseMs:10000,now:new Date()}))[0];
    assert.ok(second);
    assert.notEqual(first.leaseUntil,second.leaseUntil);
    assert.equal(await ackPostgres(pool,first.id,first.leaseOwner,first.leaseUntil),false);
    assert.equal(await failPostgres(pool,first.id,first.leaseOwner,first.leaseUntil,"stale",new Date()),false);
    assert.equal(await ackPostgres(pool,second.id,second.leaseOwner,second.leaseUntil),true);
  }finally{await pool.end()}
});
