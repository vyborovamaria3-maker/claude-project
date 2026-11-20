import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import pg from "pg";
import {
  POSTGRES_OUTBOX_DDL,emitPostgres,claimPostgres,ackPostgres,failPostgres,
} from "../dist/index.js";

// Concurrency and failure-recovery coverage on a disposable PostgreSQL server.
// OUTBOX_TEST_PG_URL must point at a test-only database; the suite installs
// the outbox DDL inside an isolated random schema and drops it afterwards.
const url=process.env.OUTBOX_TEST_PG_URL;

async function withIsolatedOutbox(fn){
  const admin=new pg.Pool({connectionString:url,max:2});
  const schema="outbox_conc_"+randomBytes(5).toString("hex");
  const pool=new pg.Pool({
    connectionString:url,max:12,
    options:`-c search_path=${schema},public`,
  });
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(POSTGRES_OUTBOX_DDL);
    await fn(pool);
  }finally{
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

function makeEvents(count,prefix){
  return Array.from({length:count},(_,i)=>({
    sourceSystem:"x",
    eventKind:"tweet_seen",
    eventKey:`${prefix}:${i}:v1`,
    schemaVersion:"x-v1",
    payload:{index:i},
  }));
}

test("actual PostgreSQL: parallel workers handle each event exactly once",{
  skip:!url,
},async()=>{
  await withIsolatedOutbox(async(pool)=>{
    const total=60;
    for(const event of makeEvents(total,"conc")){
      const writer=await pool.connect();
      try{await writer.query("BEGIN");await emitPostgres(writer,event);await writer.query("COMMIT");}
      finally{writer.release()}
    }

    const acked=new Map();
    const workerCount=8;
    await Promise.all(Array.from({length:workerCount},async(_,w)=>{
      const workerId=`worker-${w}`;
      for(;;){
        const batch=await claimPostgres(pool,{workerId,batchSize:3,leaseMs:30000});
        if(batch.length===0)break;
        for(const claimed of batch){
          const client=await pool.connect();
          try{
            const ok=await ackPostgres(client,claimed.id,workerId,claimed.leaseUntil);
            if(ok)acked.set(claimed.id,(acked.get(claimed.id)??0)+1);
          }finally{client.release()}
        }
      }
    }));

    const ackedRows=[...acked.values()];
    assert.equal(ackedRows.length,total,
      "every event must be ACKed by exactly one worker");
    assert.deepEqual(ackedRows,Array.from({length:total},()=>1),
      "no event may be acknowledged twice under concurrent load");
    const remaining=await pool.query(
      "SELECT count(*) AS n FROM outbox_events WHERE processed_at IS NULL OR dead_lettered_at IS NOT NULL");
    assert.equal(Number(remaining.rows[0].n),0,"outbox must be fully drained");
  });
});

test("actual PostgreSQL: expired lease is re-claimed once and the stale worker loses the race",{
  skip:!url,
},async()=>{
  await withIsolatedOutbox(async(pool)=>{
    const event=makeEvents(1,"lease")[0];
    const writer=await pool.connect();
    try{await writer.query("BEGIN");await emitPostgres(writer,event);await writer.query("COMMIT");}
    finally{writer.release()}

    // Worker A claims and then "crashes" without ACK or NACK.
    const stale=await claimPostgres(pool,{workerId:"stale-worker",batchSize:5,leaseMs:1000});
    assert.equal(stale.length,1);

    // Before lease expiry no other worker may take the event.
    const early=await claimPostgres(pool,{workerId:"early-worker",batchSize:5,leaseMs:30000});
    assert.equal(early.length,0);

    // After expiry worker B re-claims the same event with a fresh token.
    // The explicit clock override simulates a retry after the lease expired,
    // keeping the test deterministic instead of sleeping a wall-clock second.
    const recovered=await claimPostgres(pool,{workerId:"recovery-worker",batchSize:5,leaseMs:30000,
      now:new Date(Date.parse(stale[0].leaseUntil)+1)});
    assert.equal(recovered.length,1);
    assert.equal(recovered[0].id,stale[0].id);
    assert.notEqual(recovered[0].leaseUntil,stale[0].leaseUntil);

    const client=await pool.connect();
    try{
      // The crashed worker's token is fenced out; exactly one ack wins.
      assert.equal(await ackPostgres(client,stale[0].id,"stale-worker",stale[0].leaseUntil),false);
      assert.equal(await ackPostgres(client,recovered[0].id,"recovery-worker",recovered[0].leaseUntil),true);
    }finally{client.release()}
  });
});

test("actual PostgreSQL: DLQ after maxAttempts, excluded from claims until operator reprocess",{
  skip:!url,
},async()=>{
  await withIsolatedOutbox(async(pool)=>{
    const event=makeEvents(1,"dlq")[0];
    const writer=await pool.connect();
    try{await writer.query("BEGIN");await emitPostgres(writer,event);await writer.query("COMMIT");}
    finally{writer.release()}

    let claimed=await claimPostgres(pool,{workerId:"w",batchSize:5,leaseMs:30000});
    assert.equal(claimed.length,1);
    let client=await pool.connect();
    try{
      assert.equal(await failPostgres(client,claimed[0].id,"w",claimed[0].leaseUntil,"transient",
        new Date(Date.now()-1000),2),true);
    }finally{client.release()}

    // Attempt 2: retried, then dead-lettered.
    claimed=await claimPostgres(pool,{workerId:"w",batchSize:5,leaseMs:30000});
    assert.equal(claimed.length,1);
    assert.equal(claimed[0].attempts,1);
    client=await pool.connect();
    try{
      assert.equal(await failPostgres(client,claimed[0].id,"w",claimed[0].leaseUntil,"fatal",new Date(),2),true);
    }finally{client.release()}

    // Dead-lettered events are excluded from claims and stay intact.
    assert.equal((await claimPostgres(pool,{workerId:"w",batchSize:5,leaseMs:30000})).length,0);
    const dead=await pool.query(
      "SELECT attempts, last_error IS NOT NULL AS has_error, processed_at FROM outbox_events");
    assert.equal(Number(dead.rows[0].attempts),2);
    assert.equal(dead.rows[0].has_error,true);
    assert.equal(dead.rows[0].processed_at,null);

    // Operator reprocessing makes the event claimable again with attempts reset.
    await pool.query(
      "UPDATE outbox_events SET dead_lettered_at=NULL, attempts=0, last_error=NULL");
    const reprocessed=await claimPostgres(pool,{workerId:"w2",batchSize:5,leaseMs:30000});
    assert.equal(reprocessed.length,1);
    client=await pool.connect();
    try{
      assert.equal(await ackPostgres(client,reprocessed[0].id,"w2",reprocessed[0].leaseUntil),true);
    }finally{client.release()}
  });
});
