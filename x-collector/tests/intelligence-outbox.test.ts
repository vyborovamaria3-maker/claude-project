import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
import type {PoolClient} from "pg";
import {
  buildXTweetOutboxEvent,emitXTweetOutbox,xIntelligenceOutboxEnabled,
} from "../src/collector/persistence/intelligence-outbox";

const tweet={id:"1234567890123456789",authorId:"9223372036854775808123",
  observedAt:Date.parse("2026-10-18T01:00:00Z"),
  postedAt:Date.parse("2026-10-18T00:45:00Z")};

test("X source Outbox is explicitly opt-in",()=>{
  assert.equal(xIntelligenceOutboxEnabled({}),false);
  assert.equal(xIntelligenceOutboxEnabled({X_INTELLIGENCE_OUTBOX_ENABLED:"1"}),false);
  assert.equal(xIntelligenceOutboxEnabled({X_INTELLIGENCE_OUTBOX_ENABLED:"true"}),true);
});
test("stable decimal author IDs survive and handles are never used as a substitute",()=>{
  const a=buildXTweetOutboxEvent(tweet,Date.now());
  assert.ok(a);
  const obj=a!.payload as {registryEvent:{entityRefs:{kind:string;canonicalId:string}[];
    evidenceRef:{sourceId:string}};timelineEvent:{occurredAt:string;observedAt:string}};
  assert.deepEqual(obj.registryEvent.entityRefs,[{
    kind:"author",canonicalId:"x:9223372036854775808123",
    firstSeenAt:"2026-10-18T01:00:00.000Z",lastSeenAt:"2026-10-18T01:00:00.000Z",
  }]);
  assert.equal(obj.registryEvent.evidenceRef.sourceId,"x:tweet:"+tweet.id);
  assert.equal(obj.timelineEvent.occurredAt,"2026-10-18T00:45:00.000Z");
  assert.equal(buildXTweetOutboxEvent({...tweet,authorId:null},Date.now()),null);
  assert.equal(buildXTweetOutboxEvent({...tweet,authorId:"@handle"},Date.now()),null);
  assert.throws(()=>buildXTweetOutboxEvent({...tweet,id:"123"},Date.now()),/Invalid tweet ID/);
});
test("observedAt is the unique revision key; unknown publish time is not invented",()=>{
  const a=buildXTweetOutboxEvent(tweet,123)!;
  const b=buildXTweetOutboxEvent({...tweet,observedAt:tweet.observedAt+1000},123)!;
  assert.notEqual(a.eventKey,b.eventKey);
  const unknown=buildXTweetOutboxEvent({...tweet,postedAt:null},123)!;
  assert.equal((unknown.payload as any).timelineEvent.occurredAt,
    (unknown.payload as any).timelineEvent.observedAt);
});
test("real PGlite: emission is atomic with source transaction and duplicates are idempotent",async()=>{
  const pg=new PGlite();
  const old=process.env.X_INTELLIGENCE_OUTBOX_ENABLED;
  const conn={query:(sql:string,params?:unknown[])=>pg.query(sql,params)} as unknown as PoolClient;
  try {
    const ddl=await fs.readFile("migrations/050_intelligence_source_outbox.sql","utf8");
    await pg.exec(ddl);
    process.env.X_INTELLIGENCE_OUTBOX_ENABLED="true";
    await pg.exec("BEGIN");
    assert.equal(await emitXTweetOutbox(conn,tweet,tweet.observedAt),true);
    await pg.exec("ROLLBACK");
    assert.equal((await pg.query<{n:string}>("SELECT count(*)::text AS n FROM outbox_events")).rows[0]?.n,"0");
    await pg.exec("BEGIN");
    assert.equal(await emitXTweetOutbox(conn,tweet,tweet.observedAt),true);
    assert.equal(await emitXTweetOutbox(conn,tweet,tweet.observedAt),true);
    await pg.exec("COMMIT");
    const rows=(await pg.query<{event_key:string;payload:Record<string,unknown>}>(
      "SELECT event_key,payload FROM outbox_events")).rows;
    assert.equal(rows.length,1);
    assert.equal(rows[0]?.event_key,buildXTweetOutboxEvent(tweet,tweet.observedAt)?.eventKey);
  } finally {
    if(old===undefined) delete process.env.X_INTELLIGENCE_OUTBOX_ENABLED;
    else process.env.X_INTELLIGENCE_OUTBOX_ENABLED=old;
    await pg.close();
  }
});
