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
    const rows=await claimPostgres(pool,{workerId:"workerA",batchSize:5,leaseMs:60000,now});
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
    const claimed=await claimPostgres(pool,{workerId:"workerA",batchSize:10,leaseMs:60000,now});
    assert.equal(claimed.length,1);
    const client=await pool.connect();
    try {
      assert.equal(await failPostgres(client,claimed[0].id,"workerA",claimed[0].leaseUntil,"fixture_transient",
        new Date(now.getTime()+120000)),true);
    }finally{client.release()}
    assert.equal((await claimPostgres(pool,{workerId:"workerB",batchSize:10,leaseMs:60000,now})).length,0);
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
