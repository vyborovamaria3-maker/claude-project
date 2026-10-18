import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import Database from "better-sqlite3";
import {
  buildEntityRef,buildEvidenceRef,buildTimelineEvent,
  formatAuthorId,formatSourceId,formatWalletId,
} from "@claude-project/contracts";
import {
  POSTGRES_OUTBOX_DDL,SQLITE_OUTBOX_DDL,
  emitPostgres,claimPostgres,ackPostgres,failPostgres,
  emitSqlite,claimSqlite,ackSqlite,failSqlite,
} from "@claude-project/event-outbox";
import {runDeliveryBatch} from "../dist/index.js";

const url=process.env.INTELLIGENCE_TEST_DB_URL;
const observed="2026-10-18T01:00:00Z";
function produce(platform,eventKind,eventKey,entity,evidence,kind) {
  const registryEvent={sourceSystem:platform,eventKind,eventKey,schemaVersion:"fixture-v1",
    entityRefs:[entity],evidenceRef:evidence};
  const timelineEvent=buildTimelineEvent({
    eventKey,kind,entityRefs:[entity],evidenceRef:evidence,
    occurredAt:observed,observedAt:observed,payload:{},
  });
  return {sourceSystem:platform,eventKind,eventKey,schemaVersion:"fixture-v1",
    payload:{registryEvent,timelineEvent}};
}
const x=produce("x","tweet_observed","x:tweet:1001:observed:1",
  buildEntityRef({kind:"author",canonicalId:formatAuthorId("x","99999"),
    firstSeenAt:observed,lastSeenAt:observed}),
  buildEvidenceRef({sourceKind:"x_tweet",tweetId:"1001",observedAt:observed}),
  "tweet_published");
const tg=produce("tg","message_observed","tg:12345:21:rev:1",
  buildEntityRef({kind:"source",canonicalId:formatSourceId("tg","12345"),
    firstSeenAt:observed,lastSeenAt:observed}),
  buildEvidenceRef({sourceKind:"tg_message",sourceAccountId:"12345",messageId:"21",observedAt:observed}),
  "tg_message_published");
const chain=produce("blockchain","wallet_transaction_observed","chain:wallet:sample:signature:sample",
  buildEntityRef({kind:"wallet",canonicalId:formatWalletId("solana","1".repeat(32)),
    firstSeenAt:observed,lastSeenAt:observed}),
  buildEvidenceRef({sourceKind:"chain_tx",chain:"solana",transactionId:"1".repeat(64),observedAt:observed}),
  "chain_transaction");

test("real PostgreSQL + SQLite to Intelligence: atomic delivery and replay",{skip:!url},async()=>{
  const schema="it_"+randomBytes(6).toString("hex");
  const admin=new pg.Client({connectionString:url});
  let pool;let sqlite;
  await admin.connect();
  try {
    await admin.query('CREATE SCHEMA "'+schema+'"');
    await admin.query('SET search_path TO "'+schema+'"');
    for(const name of ["001_entity_registry.sql","002_timeline.sql"]){
      const ddl=await readFile(new URL("../migrations/"+name,import.meta.url),"utf8");
      await admin.query(ddl);
    }
    await admin.query(POSTGRES_OUTBOX_DDL);
    pool=new pg.Pool({connectionString:url,options:"-c search_path="+schema,max:4});
    const sourcePg={
      claim:opts=>claimPostgres(pool,opts),
      ack:ev=>ackPostgres(pool,ev.id,ev.leaseOwner,ev.leaseUntil),
      fail:(ev,reason,next)=>failPostgres(pool,ev.id,ev.leaseOwner,ev.leaseUntil,reason,next),
    };
    const tx=await pool.connect();
    try{
      await tx.query("BEGIN");
      await emitPostgres(tx,x);
      await emitPostgres(tx,tg);
      await tx.query("COMMIT");
    }finally{tx.release()}
    const first=await runDeliveryBatch(sourcePg,pool,{
      workerId:"source-pg",batchSize:5,leaseMs:120000
    });
    assert.equal(first.delivered,2);
    assert.equal(first.failed,0);
    const pgReplay=await runDeliveryBatch(sourcePg,pool,{
      workerId:"source-pg",batchSize:5,leaseMs:120000
    });
    assert.equal(pgReplay.claimed,0);

    sqlite=new Database(":memory:");
    sqlite.exec(SQLITE_OUTBOX_DDL);
    sqlite.exec("BEGIN IMMEDIATE");
    emitSqlite(sqlite,chain);
    sqlite.exec("COMMIT");
    const sourceSqlite={
      claim:async opts=>claimSqlite(sqlite,opts),
      ack:async ev=>ackSqlite(sqlite,ev.id,ev.leaseOwner,ev.leaseUntil),
      fail:async(ev,reason,next)=>failSqlite(sqlite,ev.id,ev.leaseOwner,ev.leaseUntil,reason,next),
    };
    const raw=await runDeliveryBatch(sourceSqlite,pool,{
      workerId:"source-sqlite",batchSize:5,leaseMs:120000
    });
    assert.equal(raw.delivered,1);
    assert.equal(raw.failed,0);
    const counts=await pool.query(`SELECT
      (SELECT count(*)::integer FROM intelligence_inbox) AS inbox,
      (SELECT count(*)::integer FROM entity_registry) AS entities,
      (SELECT count(*)::integer FROM entity_evidence) AS evidence,
      (SELECT count(*)::integer FROM timeline_events) AS timeline`);
    assert.deepEqual(counts.rows[0],{inbox:3,entities:3,evidence:3,timeline:3});

    // Crash-after-destination-COMMIT/pre-source-ACK replay on real SQLite.
    sqlite.prepare("UPDATE outbox_events SET processed_at=NULL,lease_owner=NULL,lease_until=NULL").run();
    const again=await runDeliveryBatch(sourceSqlite,pool,{
      workerId:"reclaim-sqlite",batchSize:5,leaseMs:120000
    });
    assert.equal(again.duplicates,1);
    assert.equal(again.delivered,0);
    const count=await pool.query("SELECT count(*)::integer AS n FROM entity_evidence");
    assert.equal(count.rows[0].n,3);
  }finally{
    if(sqlite)sqlite.close();
    if(pool)await pool.end();
    try{await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE')}catch{}
    await admin.end();
  }
});
