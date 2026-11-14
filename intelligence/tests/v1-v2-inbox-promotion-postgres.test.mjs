import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {
  buildEntityRef,buildEvidenceRef,buildTimelineEvent,buildEventEnvelopeV2,
  buildVerifiedTokenLinkEvent,formatSourceId,
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
      "002_timeline.sql",
      "004_token_link_observations.sql",
      "017_inbox_payload_fingerprint.sql",
      "019_inbox_envelope_fingerprint.sql",
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

    // A registered V1 message with a schema-valid timeline payload can be
    // replayed as V2 without duplicating the materialized timeline row.
    const timelineSourceEvent=event("106");
    const timelineEvent=buildTimelineEvent({
      eventKey:timelineSourceEvent.eventKey,
      kind:"tg_message_published",
      occurredAt:timelineSourceEvent.evidenceRef.occurredAt,
      observedAt:timelineSourceEvent.evidenceRef.observedAt,
      entityRefs:timelineSourceEvent.entityRefs,
      evidenceRef:timelineSourceEvent.evidenceRef,
      payload:{},
    });
    const timelinePayload={
      registryEvent:{
        sourceSystem:timelineSourceEvent.sourceSystem,
        eventKind:timelineSourceEvent.eventKind,
        eventKey:timelineSourceEvent.eventKey,
        schemaVersion:timelineSourceEvent.schemaVersion,
        entityRefs:timelineSourceEvent.entityRefs,
        evidenceRef:timelineSourceEvent.evidenceRef,
      },
      timelineEvent,
    };
    const timelineV1Client=await pool.connect();
    try{
      await timelineV1Client.query("BEGIN");
      assert.equal(await ingestDestinationEvent(timelineV1Client,{
        sourceSystem:"tg",eventKind:"message_observed",
        eventKey:timelineSourceEvent.eventKey,schemaVersion:"tg-message-v1",
        payload:timelinePayload,createdAt:"2026-11-13T10:00:03.000Z",
      }),true);
      await timelineV1Client.query("COMMIT");
    }catch(error){
      try{await timelineV1Client.query("ROLLBACK")}catch{/* preserve first error */}
      throw error;
    }finally{timelineV1Client.release();}

    const timelineV2=buildEventEnvelopeV2({
      sourceSystem:"tg",eventKind:"message_observed",
      eventKey:timelineSourceEvent.eventKey,schemaVersion:"tg-message-v1",
      producer:{name:"tg-collector",version:"v2-fixture"},
      clocks:{
        occurredAt:timelineSourceEvent.evidenceRef.occurredAt??null,
        observedAt:timelineSourceEvent.evidenceRef.observedAt,
        emittedAt:"2026-11-13T10:00:03.000Z",
      },
      entityRefs:timelineSourceEvent.entityRefs.map(ref=>({
        kind:ref.kind,canonicalId:ref.canonicalId,
      })),
      evidenceRefs:[timelineSourceEvent.evidenceRef],
      payload:timelinePayload,
    });
    const timelineV2Client=await pool.connect();
    try{
      await timelineV2Client.query("BEGIN");
      assert.equal(await ingestDestinationEvent(timelineV2Client,{
        sourceSystem:"tg",eventKind:"message_observed",
        eventKey:timelineSourceEvent.eventKey,schemaVersion:"tg-message-v1",
        payload:timelineV2,createdAt:"2026-11-13T10:00:03.000Z",
      }),false);
      await timelineV2Client.query("COMMIT");
    }catch(error){
      try{await timelineV2Client.query("ROLLBACK")}catch{/* preserve first error */}
      throw error;
    }finally{timelineV2Client.release();}

    const timelineRows=(await pool.query(
      "SELECT count(*)::integer AS count FROM timeline_events WHERE event_key=$1",
      [timelineSourceEvent.eventKey],
    )).rows[0].count;
    assert.equal(timelineRows,1,"V1/V2 replay must preserve exactly one timeline row");
    const timelineInbox=(await pool.query(
      "SELECT envelope_sha256 FROM intelligence_inbox WHERE event_key=$1",
      [timelineSourceEvent.eventKey],
    )).rows[0];
    assert.equal(timelineInbox.envelope_sha256,timelineV2.payloadSha256);

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

    // A failed token-link materialization equality check must roll back the
    // V1→V2 fingerprint promotion in the same destination transaction.
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
    const linkV1=buildVerifiedTokenLinkEvent({
      sourceSystem:"tg",sourceEntity,evidenceRef,
      mint:"So11111111111111111111111111111111111111112",
      matchedLiteralMint:"So11111111111111111111111111111111111111112",
      sourceRevisionSha256:"a".repeat(64),
      mintVerification:{
        chainId:"solana-mainnet",method:"spl_mint_account",
        tokenProgram:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        provider:"helius-solana-rpc",checkedAt:observedAt,
      },
    });
    const emittedAt="2026-11-13T10:00:03.000Z";
    const v1Client=await pool.connect();
    try{
      await v1Client.query("BEGIN");
      assert.equal(await ingestDestinationEvent(v1Client,{
        ...linkV1,createdAt:emittedAt,
      }),true);
      await v1Client.query("COMMIT");
    }catch(error){
      try{await v1Client.query("ROLLBACK")}catch{/* preserve first error */}
      throw error;
    }finally{v1Client.release();}

    const envelope=(provider)=>buildEventEnvelopeV2({
      sourceSystem:"tg",eventKind:"token_link_verified",
      eventKey:linkV1.eventKey,schemaVersion:"token-link-v1",
      producer:{name:"tg-collector",version:"v2-fixture"},
      clocks:{occurredAt,observedAt,emittedAt},
      entityRefs:linkV1.payload.registryEvent.entityRefs.map(ref=>({
        kind:ref.kind,canonicalId:ref.canonicalId,
      })),
      evidenceRefs:[evidenceRef],
      payload:{
        ...linkV1.payload,
        tokenLink:{
          ...linkV1.payload.tokenLink,
          mintVerification:{
            ...linkV1.payload.tokenLink.mintVerification,provider,
          },
        },
      },
    });
    const mismatched=envelope("alchemy-solana-rpc");
    const badClient=await pool.connect();
    try{
      await badClient.query("BEGIN");
      await assert.rejects(ingestDestinationEvent(badClient,{
        sourceSystem:"tg",eventKind:"token_link_verified",
        eventKey:linkV1.eventKey,schemaVersion:"token-link-v1",
        payload:mismatched,createdAt:emittedAt,
      }),/Token link event identity collision/);
      await badClient.query("ROLLBACK");
    }finally{badClient.release();}
    const afterRollback=(await pool.query(
      "SELECT envelope_sha256 FROM intelligence_inbox WHERE event_key=$1",[linkV1.eventKey],
    )).rows[0];
    assert.equal(afterRollback.envelope_sha256,null,
      "failed token-link parity must roll back the envelope hash promotion");

    const matching=envelope("helius-solana-rpc");
    const goodClient=await pool.connect();
    try{
      await goodClient.query("BEGIN");
      assert.equal(await ingestDestinationEvent(goodClient,{
        sourceSystem:"tg",eventKind:"token_link_verified",
        eventKey:linkV1.eventKey,schemaVersion:"token-link-v1",
        payload:matching,createdAt:emittedAt,
      }),false);
      await goodClient.query("COMMIT");
    }catch(error){
      try{await goodClient.query("ROLLBACK")}catch{/* preserve first error */}
      throw error;
    }finally{goodClient.release();}
    const afterPromotion=(await pool.query(
      "SELECT envelope_sha256 FROM intelligence_inbox WHERE event_key=$1",[linkV1.eventKey],
    )).rows[0];
    assert.equal(afterPromotion.envelope_sha256,matching.payloadSha256);


    const v2First=event("104");
    const v2FirstHash="e".repeat(64);
    const v2FirstClient=await pool.connect();
    try{
      await v2FirstClient.query("BEGIN");
      assert.equal(await ingestRegistryEvent(v2FirstClient,v2First,{
        envelopeSha256:v2FirstHash,
      }),true);
      await v2FirstClient.query("COMMIT");
    }catch(error){
      try{await v2FirstClient.query("ROLLBACK")}catch{/* preserve first error */}
      throw error;
    }finally{v2FirstClient.release();}
    const v2FirstStored=(await pool.query(
      "SELECT payload_sha256,envelope_sha256 FROM intelligence_inbox WHERE event_key=$1",
      [v2First.eventKey],
    )).rows[0];
    assert.equal(v2FirstStored.payload_sha256,registryEventFingerprint(v2First));
    assert.equal(v2FirstStored.envelope_sha256,v2FirstHash);

    const legacy=event("105");
    await pool.query(`INSERT INTO intelligence_inbox
      (source_system,event_kind,event_key,schema_version,evidence_source_id,payload_sha256)
      VALUES($1,$2,$3,$4,$5,NULL)`,[
      legacy.sourceSystem,legacy.eventKind,legacy.eventKey,legacy.schemaVersion,
      legacy.evidenceRef.sourceId,
    ]);
    const legacyClient=await pool.connect();
    try{
      await legacyClient.query("BEGIN");
      await assert.rejects(
        ingestRegistryEvent(legacyClient,legacy,{envelopeSha256:"f".repeat(64)}),
        /legacy fingerprint missing/,
      );
      await legacyClient.query("ROLLBACK");
    }finally{legacyClient.release();}
  }finally{
    if(pool)await pool.end();
    await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
    await admin.end();
  }
});
