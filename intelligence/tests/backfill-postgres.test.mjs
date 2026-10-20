import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import pg from "pg";
import {readFile} from "node:fs/promises";
import {
  POSTGRES_OUTBOX_DDL,claimPostgres,ackPostgres,failPostgres,
} from "@claude-project/event-outbox";
import {runDeliveryBatch} from "../dist/index.js";
import {
  processPgPage,readHighWater,
} from "../scripts/backfill.mjs";
import {checkpointFor,advanceCheckpoint} from "../scripts/backfill-core.mjs";

const url=process.env.INTELLIGENCE_TEST_DB_URL;
const observedX=1792461000000;
const observedTG="2026-10-20T01:10:00Z";
function outboxPort(pool){
  return {
    claim:args=>claimPostgres(pool,args),
    ack:event=>ackPostgres(pool,event.id,event.leaseOwner,event.leaseUntil),
    fail:(event,code,next)=>failPostgres(pool,event.id,event.leaseOwner,event.leaseUntil,code,next),
  };
}
async function count(pool,sql){
  return Number((await pool.query(sql)).rows[0].n);
}
test("ARCH-08 X/TG source snapshots commit to independent outboxes, then real Intelligence; restarts are idempotent",{
  skip:!url,
},async()=>{
  const suffix=randomBytes(5).toString("hex");
  const schemas={x:"bf_x_"+suffix,tg:"bf_tg_"+suffix,dst:"bf_dst_"+suffix};
  const admin=new pg.Client({connectionString:url});
  const pools={};
  await admin.connect();
  try{
    for(const schema of Object.values(schemas)){
      await admin.query('CREATE SCHEMA "'+schema+'"');
    }
    await admin.query('SET search_path TO "'+schemas.x+'"');
    await admin.query("CREATE TABLE twitter_tweets(tweet_id TEXT PRIMARY KEY,author_id TEXT,updated_at BIGINT,posted_at BIGINT)");
    await admin.query(POSTGRES_OUTBOX_DDL);
    await admin.query("INSERT INTO twitter_tweets VALUES($1,$2,$3,$4),($5,$6,$7,$8)",[
      "9","999",observedX,1700000000000,
      "100",null,observedX,1700000000000,
    ]);

    await admin.query('SET search_path TO "'+schemas.tg+'"');
    await admin.query("CREATE TABLE tg_sources(id BIGINT PRIMARY KEY,peer_id TEXT)");
    await admin.query("CREATE TABLE tg_messages("+
      "source_id BIGINT,message_id BIGINT,posted_at TIMESTAMPTZ,"+
      "collected_at TIMESTAMPTZ,deleted_at TIMESTAMPTZ,text TEXT)");
    await admin.query(POSTGRES_OUTBOX_DDL);
    await admin.query("INSERT INTO tg_sources VALUES(1,'12345')");
    await admin.query("INSERT INTO tg_messages VALUES "+
      "(1,41,'2026-10-19T22:00:00Z',$1,NULL,'private TG text'),"+
      "(1,42,'2026-10-19T23:00:00Z',$1,$1,'deleted private TG text')",[observedTG]);

    await admin.query('SET search_path TO "'+schemas.dst+'"');
    for(const file of ["001_entity_registry.sql","002_timeline.sql"]){
      await admin.query(await readFile(new URL("../migrations/"+file,import.meta.url),"utf8"));
    }
    for(const [name,schema] of Object.entries(schemas)){
      pools[name]=new pg.Pool({connectionString:url,options:"-c search_path="+schema,max:3});
    }
    const xHigh=await readHighWater("x",pools.x);
    assert.deepEqual(xHigh,{len:3,id:"100"},"text tweet IDs are ordered by length then lexically");
    const xState=checkpointFor("x","isolated-x-test",xHigh);
    const preview=await processPgPage(pools.x,"x",xState,1,false);
    assert.equal(preview.rows.length,1);
    assert.equal(await count(pools.x,"SELECT count(*)::integer AS n FROM outbox_events"),0);

    let batch=await processPgPage(pools.x,"x",xState,1,true);
    assert.equal(batch.stats.inserted,1);
    const replay=await processPgPage(pools.x,"x",xState,1,true);
    assert.equal(replay.stats.duplicates,1,
      "crash after source COMMIT but before checkpoint must replay safely");
    const next=advanceCheckpoint(xState,batch.rows,batch.stats,"x");
    batch=await processPgPage(pools.x,"x",next,1,true);
    assert.equal(batch.stats.excluded,1,"missing author does not create a guess");
    assert.equal(await count(pools.x,"SELECT count(*)::integer AS n FROM outbox_events"),1);

    const tHigh=await readHighWater("tg",pools.tg);
    assert.deepEqual(tHigh,{sourceId:"1",messageId:"42"});
    const tgState=checkpointFor("tg","isolated-tg-test",tHigh);
    const tg=await processPgPage(pools.tg,"tg",tgState,10,true);
    assert.equal(tg.rows.length,1,"a deleted source snapshot cannot become current event");
    assert.equal(tg.stats.inserted,1);
    const tgReplay=await processPgPage(pools.tg,"tg",tgState,10,true);
    assert.equal(tgReplay.stats.duplicates,1);
    const telegramPayload=(await pools.tg.query(
      "SELECT payload FROM outbox_events LIMIT 1")).rows[0].payload;
    assert.equal(telegramPayload.registryEvent.evidenceRef.observedAt,
      new Date(observedTG).toISOString());
    assert.equal(telegramPayload.registryEvent.evidenceRef.occurredAt,
      "2026-10-19T22:00:00.000Z");
    assert.equal(JSON.stringify(telegramPayload).includes("private TG text"),false);
    assert.deepEqual(telegramPayload.registryEvent.entityRefs.map(x=>x.kind),["source"]);

    for(const [source,pool] of [["x",pools.x],["tg",pools.tg]]){
      const result=await runDeliveryBatch(outboxPort(pool),pools.dst,{
        workerId:"bf-"+source,batchSize:10,leaseMs:120000,
      });
      assert.equal(result.delivered,1);
      assert.equal(result.failed,0);
    }
    assert.equal(await count(pools.dst,
      "SELECT count(*)::integer AS n FROM intelligence_inbox"),2);
    assert.equal(await count(pools.dst,
      "SELECT count(*)::integer AS n FROM timeline_events"),2);
    assert.equal(await count(pools.dst,
      "SELECT count(*)::integer AS n FROM timeline_event_entities"),2);
    assert.equal(await count(pools.dst,
      "SELECT count(*)::integer AS n FROM entity_evidence"),2);
    const clocks=await pools.dst.query("SELECT source_system,observed_at,occurred_at FROM timeline_events ORDER BY source_system");
    assert.equal(clocks.rows.length,2);
    assert.equal(new Date(clocks.rows[1].observed_at).toISOString(),
      new Date(observedTG).toISOString());
  }finally{
    for(const pool of Object.values(pools))await pool.end();
    for(const schema of Object.values(schemas).reverse()){
      try{await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE')}
      catch{ /* retain previous failure */ }
    }
    await admin.end();
  }
});
