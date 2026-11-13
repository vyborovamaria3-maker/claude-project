import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {
  buildEntityRef,buildEvidenceRef,buildTimelineEvent,buildEventEnvelopeV2,formatSourceId,
} from "@claude-project/contracts";
import {
  ingestRegistryEvent,ingestDestinationEvent,registryEventFingerprint,
} from "../dist/index.js";

const url=process.env.INTELLIGENCE_TEST_DB_URL;

function event(messageId){
  const key="tg:message:-100321:"+messageId;
  const observedAt="2026-11-13T10:00:00.000Z";
  const entity=buildEntityRef({
    kind:"source",canonicalId:formatSourceId("tg","-100321"),
    firstSeenAt:observedAt,lastSeenAt:observedAt,
  });
  const evidenceRef=buildEvidenceRef({
    sourceKind:"tg_message",sourceAccountId:"-100321",messageId,
    observedAt,occurredAt:"2026-11-13T09:59:00.000Z",
  });
  return {
    sourceSystem:"tg",eventKind:"message_observed",eventKey:key,
    schemaVersion:"tg-message-v1",entityRefs:[entity],evidenceRef,
  };
}

test("PostgreSQL preserves V1 registry identity while promoting and fencing V2 envelope hashes",{
  skip:!url,
},async()=>{
  const suffix=randomBytes(6).toString("hex");
  const schema="v2_promote_"+suffix;
  const admin=new pg.Client({connectionString:url});
  let pool;
  await admin.connect();
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');
    await admin.query('SET search_path TO "'+schema+'"');
    for(const file of [
      "001_entity_registry.sql",
      "017_inbox_payload_fingerprint.sql",
      "019_inbox_envelope_fingerprint.sql",
      "002_timeline.sql",
    ]){
      await admin.query(await readFile(new URL("../migrations/"+file,import.meta.url),"utf8"));
    }
    // Additive migration must be safely replayable in disposable upgrade rehearsals.
    await admin.query(await readFile(new URL("../migrations/019_inbox_envelope_fingerprint.sql",import.meta.url),"utf8"));
    pool=new pg.Pool({connectionString:url,options:"-c search_path="+schema,max:5});

    const original=event("101");
    const registrySha=registryEventFingerprint(original);
    const v2Hash="a".repeat(64);
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      assert.equal(await ingestRegistryEvent(client,original),true);
      await client.query("COMMIT");
      await client.query("BEGIN");
      assert.equal(await ingestRegistryEvent(client,original,{envelopeSha256:v2Hash}),false);
      await client.query("COMMIT");
      await client.query("BEGIN");
      assert.equal(await ingestRegistryEvent(client,original,{envelopeSha256:v2Hash}),false);
      await assert.rejects(
        ingestRegistryEvent(client,original,{envelopeSha256:"b".repeat(64)}),
        /V2 envelope hash mismatch/,
      );
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      assert.equal(await ingestRegistryEvent(client,original),false,
        "a V1 replay after promotion must still match the stable registry fingerprint");
      await client.query("COMMIT");
    }finally{client.release();}

    const stored=(await pool.query(
      "SELECT payload_sha256,envelope_sha256 FROM intelligence_inbox WHERE event_key=$1",
      [original.eventKey],
    )).rows[0];
    assert.equal(stored.payload_sha256,registrySha);
    assert.equal(stored.envelope_sha256,v2Hash);

    const concurrent=event("102");
    const seed=await pool.connect();
    try{
      await seed.query("BEGIN");
      assert.equal(await ingestRegistryEvent(seed,concurrent),true);
      await seed.query("COMMIT");
    }finally{seed.release();}

    const attempt=async(hash)=>{
      const tx=await pool.connect();
      try{
        await tx.query("BEGIN");
        const result=await ingestRegistryEvent(tx,concurrent,{envelopeSha256:hash});
        await tx.query("COMMIT");
        return result;
      }catch(error){
        try{await tx.query("ROLLBACK")}catch{/* preserve first error */}
        throw error;
      }finally{tx.release();}
    };
    const raced=await Promise.allSettled([
      attempt("c".repeat(64)),attempt("d".repeat(64)),
    ]);
    assert.equal(raced.filter(x=>x.status==="fulfilled").length,1,
      "only one concurrent V2 envelope may promote a V1 inbox row");
    assert.equal(raced.filter(x=>x.status==="rejected").length,1,
      "a competing, different envelope must fail closed");
    const concurrentStored=(await pool.query(
      "SELECT payload_sha256,envelope_sha256 FROM intelligence_inbox WHERE event_key=$1",
      [concurrent.eventKey],
    )).rows[0];
    assert.equal(concurrentStored.payload_sha256,registryEventFingerprint(concurrent));
    assert.ok(["c".repeat(64),"d".repeat(64)].includes(concurrentStored.envelope_sha256));

    // A failed downstream timeline equality check must roll back the V1→V2
    // fingerprint promotion in the same destination transaction.
    const observedAt="2026-11-13T10:00:00.000Z";
    const occurredAt="2026-11-13T09:59:00.000Z";
    const sourceEntity=buildEntityRef({
      kind:"source",canonicalId:formatSourceId("tg","-100321"),
      firstSeenAt:observedAt,lastSeenAt:observedAt,
    });
    const evidenceRef=buildEvidenceRef({
      sourceKind:"tg_message",sourceAccountId:"-100321",messageId:"103",
      observedAt,occurredAt,parserVersion:"tg-collector-v1",
    });
    const eventKey="tg:message:-100321:103:observed:"+Date.parse(observedAt);
    const registryEvent={
      sourceSystem:"tg",eventKind:"message_observed",eventKey,
      schemaVersion:"tg-message-v1",entityRefs:[sourceEntity],evidenceRef,
    };
    const timeline=(payload)=>buildTimelineEvent({
      eventKey,kind:"tg_message_published",occurredAt,observedAt,
      entityRefs:[sourceEntity],evidenceRef,payload,
    });
    const originalPayload={registryEvent,timelineEvent:timeline({textHash:"original"})};
    const emittedAt="2026-11-13T10:00:03.000Z";
    const v1Client=await pool.connect();
    try{
      await v1Client.query("BEGIN");
      assert.equal(await ingestDestinationEvent(v1Client,{
        sourceSystem:"tg",eventKind:"message_observed",eventKey,
        schemaVersion:"tg-message-v1",payload:originalPayload,createdAt:emittedAt,
      }),true);
      await v1Client.query("COMMIT");
    }catch(error){
      try{await v1Client.query("ROLLBACK")}catch{/* preserve first error */}
      throw error;
    }finally{v1Client.release();}

    const envelope=(timelinePayload,version="v2-fixture")=>buildEventEnvelopeV2({
      sourceSystem:"tg",eventKind:"message_observed",eventKey,
      schemaVersion:"tg-message-v1",
      producer:{name:"tg-collector",version},
      clocks:{occurredAt,observedAt,emittedAt},
      entityRefs:[{kind:"source",canonicalId:sourceEntity.canonicalId}],
      evidenceRefs:[evidenceRef],
      payload:{registryEvent,timelineEvent:timeline(timelinePayload)},
    });
    const mismatched=envelope({textHash:"changed"});
    const badClient=await pool.connect();
    try{
      await badClient.query("BEGIN");
      await assert.rejects(ingestDestinationEvent(badClient,{
        sourceSystem:"tg",eventKind:"message_observed",eventKey,
        schemaVersion:"tg-message-v1",payload:mismatched,createdAt:emittedAt,
      }),/Timeline event identity collision/);
      await badClient.query("ROLLBACK");
    }finally{badClient.release();}
    const afterRollback=(await pool.query(
      "SELECT envelope_sha256 FROM intelligence_inbox WHERE event_key=$1",[eventKey],
    )).rows[0];
    assert.equal(afterRollback.envelope_sha256,null,
      "failed timeline parity must roll back the envelope hash promotion");

    const matching=envelope({textHash:"original"});
    const goodClient=await pool.connect();
    try{
      await goodClient.query("BEGIN");
      assert.equal(await ingestDestinationEvent(goodClient,{
        sourceSystem:"tg",eventKind:"message_observed",eventKey,
        schemaVersion:"tg-message-v1",payload:matching,createdAt:emittedAt,
      }),false);
      await goodClient.query("COMMIT");
    }catch(error){
      try{await goodClient.query("ROLLBACK")}catch{/* preserve first error */}
      throw error;
    }finally{goodClient.release();}
    const afterPromotion=(await pool.query(
      "SELECT envelope_sha256 FROM intelligence_inbox WHERE event_key=$1",[eventKey],
    )).rows[0];
    assert.equal(afterPromotion.envelope_sha256,matching.payloadSha256);
  }finally{
    if(pool)await pool.end();
    await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
    await admin.end();
  }
});
