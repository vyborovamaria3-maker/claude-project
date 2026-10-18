import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {buildEntityRef,buildEvidenceRef,formatAuthorId,formatSourceId} from "@claude-project/contracts";
import {
  POSTGRES_OUTBOX_DDL,emitPostgres,claimPostgres,ackPostgres,failPostgres,
} from "@claude-project/event-outbox";
import {runDeliveryBatch} from "../dist/index.js";

const url=process.env.INTELLIGENCE_TEST_DB_URL;

test("independent X/TG PG sources deliver to a separate Intelligence schema with ACK-after-commit",{skip:!url},async()=>{
  const suffix=randomBytes(5).toString("hex");
  const sources={x:"source_x_"+suffix,tg:"source_tg_"+suffix,dst:"intelligence_"+suffix};
  const admin=new pg.Client({connectionString:url});
  let xPool, tgPool, destPool;
  await admin.connect();
  try {
    for (const schema of Object.values(sources)) {
      await admin.query('CREATE SCHEMA "'+schema+'"');
    }
    for (const name of ["x","tg"]) {
      await admin.query('SET search_path TO "'+sources[name]+'"');
      await admin.query(POSTGRES_OUTBOX_DDL);
    }
    await admin.query('SET search_path TO "'+sources.dst+'"');
    for (const name of ["001_entity_registry.sql","002_timeline.sql"]) {
      await admin.query(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
    }
    const poolFor=(schema)=>new pg.Pool({connectionString:url,options:"-c search_path="+schema,max:3});
    xPool=poolFor(sources.x); tgPool=poolFor(sources.tg); destPool=poolFor(sources.dst);
    for (const [pool, schema] of [[xPool,sources.x],[tgPool,sources.tg],[destPool,sources.dst]]) {
      assert.equal((await pool.query("SELECT current_schema() AS name")).rows[0].name,schema);
    }
    const when="2026-10-18T01:00:00Z";
    const fixtures=[
      {pool:xPool,platform:"x",eventKind:"tweet_observed",eventKey:"x:tweet:900000:v1",
        kind:"author",canonicalId:formatAuthorId("x","9999"),
        evidence:buildEvidenceRef({sourceKind:"x_tweet",tweetId:"900000",observedAt:when})},
      {pool:tgPool,platform:"tg",eventKind:"message_observed",eventKey:"tg:12345:77:v1",
        kind:"source",canonicalId:formatSourceId("tg","12345"),
        evidence:buildEvidenceRef({sourceKind:"tg_message",sourceAccountId:"12345",messageId:"77",observedAt:when})},
    ];
    for(const item of fixtures) {
      const ref=buildEntityRef({kind:item.kind,canonicalId:item.canonicalId,firstSeenAt:when,lastSeenAt:when});
      const registryEvent={
        sourceSystem:item.platform,eventKind:item.eventKind,eventKey:item.eventKey,
        schemaVersion:"fixture-v1",entityRefs:[ref],evidenceRef:item.evidence,
      };
      const event={
        sourceSystem:item.platform,eventKind:item.eventKind,eventKey:item.eventKey,
        schemaVersion:"fixture-v1",payload:{registryEvent},
      };
      const client=await item.pool.connect();
      try {
        await client.query("BEGIN");
        await emitPostgres(client,event);
        await client.query("COMMIT");
      } catch(error) {
        try{await client.query("ROLLBACK")}catch{}
        throw error;
      }finally{client.release()}
    }
    const port=(pool)=>({
      claim:options=>claimPostgres(pool,options),
      ack:event=>ackPostgres(pool,event.id,event.leaseOwner,event.leaseUntil),
      fail:(event,reason,next)=>failPostgres(pool,event.id,event.leaseOwner,event.leaseUntil,reason,next),
    });
    const xStats=await runDeliveryBatch(port(xPool),destPool,{workerId:"x-worker",batchSize:5,leaseMs:120000});
    assert.equal(xStats.delivered,1);
    assert.equal(xStats.failed,0);
    assert.equal((await tgPool.query("SELECT count(*)::integer AS n FROM outbox_events WHERE processed_at IS NULL")).rows[0].n,1,
      "TG source is independent; X ACK must not touch it");
    const tgStats=await runDeliveryBatch(port(tgPool),destPool,{workerId:"tg-worker",batchSize:5,leaseMs:120000});
    assert.equal(tgStats.delivered,1);
    assert.equal(tgStats.failed,0);
    const inbox=await destPool.query("SELECT source_system,evidence_source_id FROM intelligence_inbox ORDER BY source_system");
    assert.deepEqual(inbox.rows.map(x=>x.source_system),["tg","x"]);
    assert.deepEqual(inbox.rows.map(x=>x.evidence_source_id),["tg:message:12345:77","x:tweet:900000"]);
    assert.equal((await destPool.query("SELECT count(*)::integer AS n FROM entity_registry")).rows[0].n,2);
    for(const pool of [xPool,tgPool]) {
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM outbox_events WHERE processed_at IS NOT NULL")).rows[0].n,1);
    }
    // Commit succeeded but ACK state was lost, so source redelivers safely.
    await xPool.query("UPDATE outbox_events SET processed_at=NULL,lease_owner=NULL,lease_until=NULL");
    const replay=await runDeliveryBatch(port(xPool),destPool,{workerId:"x-replay",batchSize:1,leaseMs:120000});
    assert.equal(replay.duplicates,1);
    assert.equal(replay.delivered,0);
    assert.equal((await destPool.query("SELECT count(*)::integer AS n FROM entity_evidence")).rows[0].n,2);
  }finally{
    if(xPool)await xPool.end();
    if(tgPool)await tgPool.end();
    if(destPool)await destPool.end();
    for(const schema of Object.values(sources).reverse()) {
      try{await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE')}catch{}
    }
    await admin.end();
  }
});
