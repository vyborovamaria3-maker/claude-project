import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidenceRef,buildEntityRef,buildTimelineEvent,buildEventEnvelopeV2,
  formatTokenId,formatSourceId,buildVerifiedTokenLinkEvent,
} from "@claude-project/contracts";
import {runDeliveryBatch} from "../dist/index.js";

const when="2026-10-18T00:00:00Z";
const registryEvent={
  sourceSystem:"tg",eventKind:"message_observed",eventKey:"tg:-10022:42:v1",
  schemaVersion:"tg-v1",
  entityRefs:[buildEntityRef({kind:"token",
    canonicalId:formatTokenId("solana","So11111111111111111111111111111111111111112"),
    firstSeenAt:when,lastSeenAt:when})],
  evidenceRef:buildEvidenceRef({
    sourceKind:"tg_message",sourceAccountId:"-10022",messageId:"42",observedAt:when}),
};
function sample(payload={registryEvent}){
  return {id:"1",sourceSystem:"tg",eventKind:"message_observed",eventKey:"tg:-10022:42:v1",
    schemaVersion:"tg-v1",payload,createdAt:"2026-10-18T00:00:03.000Z",
    attempts:0,leaseOwner:"worker1",leaseUntil:"2026-10-18T00:30:00Z"};
}
const registeredObservedAt="2026-10-18T00:00:00.000Z";
const registeredOccurredAt="2026-10-17T23:59:00.000Z";
const registeredEmittedAt="2026-10-18T00:00:03.000Z";
const registeredEventKey="tg:message:-10022:42:observed:1760745600000";
const registeredEntity=buildEntityRef({
  kind:"source",canonicalId:formatSourceId("tg","-10022"),
  firstSeenAt:registeredObservedAt,lastSeenAt:registeredObservedAt,
});
const registeredEvidence=buildEvidenceRef({
  sourceKind:"tg_message",sourceAccountId:"-10022",messageId:"42",
  observedAt:registeredObservedAt,occurredAt:registeredOccurredAt,
  parserVersion:"tg-collector-v1",
});
const registeredPayload={
  registryEvent:{
    sourceSystem:"tg",eventKind:"message_observed",eventKey:registeredEventKey,
    schemaVersion:"tg-message-v1",entityRefs:[registeredEntity],
    evidenceRef:registeredEvidence,
  },
  timelineEvent:buildTimelineEvent({
    eventKey:registeredEventKey,kind:"tg_message_published",
    occurredAt:registeredOccurredAt,observedAt:registeredObservedAt,
    entityRefs:[registeredEntity],evidenceRef:registeredEvidence,payload:{},
  }),
};
function registeredClaim(payload=registeredPayload,createdAt=registeredEmittedAt){
  return {
    id:"registered-1",sourceSystem:"tg",eventKind:"message_observed",
    eventKey:registeredEventKey,schemaVersion:"tg-message-v1",payload,
    createdAt,attempts:0,leaseOwner:"worker1",leaseUntil:"2026-10-18T00:30:00Z",
  };
}
function registeredV2(producerVersion="v2-fixture"){
  return buildEventEnvelopeV2({
    sourceSystem:"tg",eventKind:"message_observed",eventKey:registeredEventKey,
    schemaVersion:"tg-message-v1",
    producer:{name:"tg-collector",version:producerVersion},
    clocks:{
      occurredAt:registeredOccurredAt,observedAt:registeredObservedAt,
      emittedAt:registeredEmittedAt,
    },
    entityRefs:[{kind:"source",canonicalId:registeredEntity.canonicalId}],
    evidenceRefs:[registeredEvidence],
    payload:registeredPayload,
  });
}
function v2Claim(envelope=registeredV2(),createdAt=registeredEmittedAt){
  return {...registeredClaim(envelope,createdAt),payload:envelope};
}
function statefulInboxDestination(log){
  let stored=null;
  return {
    connect:async()=>({
      query:async(sql,params)=>{
        log.push({sql,params});
        if(sql.includes("INSERT INTO intelligence_inbox")){
          if(stored===null){
            stored=params[5];
            return {rows:[{event_key:registeredEventKey}]};
          }
          return {rows:[]};
        }
        if(sql.includes("SELECT schema_version,evidence_source_id,payload_sha256 FROM intelligence_inbox")){
          return {rows:[{
            schema_version:"tg-message-v1",
            evidence_source_id:registeredEvidence.sourceId,
            payload_sha256:stored,
          }]};
        }
        return {rows:sql.includes("RETURNING event_key")?[{event_key:registeredEventKey}]:[]};
      },
      release:()=>log.push("release"),
    }),
  };
}
function stubDestination(log, fail=false) {
  return {connect:async()=>({
    query:async sql=>{
      log.push(sql);
      if(fail && sql.includes("entity_registry")) throw new Error("DB unavailable");
      return {rows:sql.includes("RETURNING event_key")?[{event_key:"ok"}]:[]};
    },
    release:()=>log.push("release")
  })};
}
test("ACK only after destination commit",async()=>{
  const log=[];
  const source={claim:async()=>[sample()],ack:async()=>{log.push("ACK");return true},
    fail:async()=>{log.push("FAIL");return true}};
  const stats=await runDeliveryBatch(source,stubDestination(log),
    {workerId:"worker1",batchSize:10,leaseMs:5000});
  assert.equal(stats.delivered,1);
  assert.equal(stats.failed,0);
  assert.ok(log.indexOf("COMMIT")<log.indexOf("ACK"));
  assert.ok(!log.includes("FAIL"));
  assert.ok(log.indexOf("release")<log.indexOf("ACK"));
});

test("delivery persists legacy invalidations before migration 018 adds coalescing",async()=>{
  const log=[];
  const tokenId=registryEvent.entityRefs[0].canonicalId;
  const destination={connect:async()=>({
    query:async sql=>{
      log.push(sql);
      if(sql.includes("to_regclass('analytics_invalidation_queue')"))
        return {rows:[{ready:true,coalesce_key_ready:false}]};
      if(sql.includes("SELECT DISTINCT canonical_token_id"))
        return {rows:[{canonical_token_id:tokenId}]};
      if(sql.includes("INSERT INTO analytics_invalidation_queue"))
        return {rows:[{invalidation_id:17}]};
      return {rows:sql.includes("RETURNING event_key")?[{event_key:"ok"}]:[]};
    },
    release:()=>log.push("release"),
  })};
  const source={claim:async()=>[sample()],ack:async()=>{log.push("ACK");return true},
    fail:async()=>{log.push("FAIL");return true}};
  const result=await runDeliveryBatch(source,destination,
    {workerId:"worker1",batchSize:1,leaseMs:5000});
  assert.equal(result.delivered,1);
  assert.equal(result.failed,0);
  const legacyInsert=log.find(sql=>typeof sql==="string"&&sql.includes("INSERT INTO analytics_invalidation_queue"));
  assert.ok(legacyInsert,"migration-010 queue must receive the event before source ACK");
  assert.ok(!legacyInsert.includes("coalesce_key"),"legacy schema must not require migration-018 columns");
  assert.ok(log.some(sql=>typeof sql==="string"&&sql.includes("INSERT INTO analytics_invalidation_log")),
    "legacy queue insert must retain the audit transition");
  assert.ok(log.indexOf("COMMIT")<log.indexOf("ACK"));
});

test("delivery tolerates a partially-added coalesce column without losing legacy uniqueness",async()=>{
  const log=[];
  const tokenId=registryEvent.entityRefs[0].canonicalId;
  let queueArgs;
  const destination={connect:async()=>({
    query:async (sql,params)=>{
      log.push(sql);
      if(sql.includes("to_regclass('analytics_invalidation_queue')"))
        return {rows:[{
          ready:true,coalesce_key_ready:true,retry_schedule_ready:false,
          cursor_ready:false,coalesce_index_ready:false,
        }]};
      if(sql.includes("SELECT DISTINCT canonical_token_id"))
        return {rows:[{canonical_token_id:tokenId}]};
      if(sql.includes("INSERT INTO analytics_invalidation_queue")){
        queueArgs=params;
        return {rows:[{invalidation_id:18}]};
      }
      return {rows:sql.includes("RETURNING event_key")?[{event_key:"ok"}]:[]};
    },
    release:()=>log.push("release"),
  })};
  const source={claim:async()=>[sample()],ack:async()=>{log.push("ACK");return true},
    fail:async()=>{log.push("FAIL");return true}};
  const result=await runDeliveryBatch(source,destination,
    {workerId:"worker1",batchSize:1,leaseMs:5000});
  assert.equal(result.delivered,1);
  assert.equal(result.failed,0);
  const legacyInsert=log.find(sql=>typeof sql==="string"&&sql.includes("INSERT INTO analytics_invalidation_queue"));
  assert.ok(legacyInsert);
  assert.ok(legacyInsert.includes("coalesce_key"));
  assert.ok(legacyInsert.includes("VALUES ($1,$2,$3,$4,$5,$4)"),
    "partial migration must use event_key as the temporary coalesce key");
  assert.ok(legacyInsert.includes("ON CONFLICT(canonical_token_id,source_system,event_kind,event_key,reason)"));
  assert.deepEqual(queueArgs,[
    tokenId,"tg","message_observed","tg:-10022:42:v1","edit",
  ]);
  assert.ok(log.indexOf("COMMIT")<log.indexOf("ACK"));
});

test("rollback before NACK on failed destination write",async()=>{
  const log=[];
  const source={claim:async()=>[sample()],ack:async()=>{log.push("ACK");return true},
    fail:async(e,code)=>{log.push("FAIL:"+code);return true}};
  const stats=await runDeliveryBatch(source,stubDestination(log,true),
    {workerId:"worker1",batchSize:10,leaseMs:5000});
  assert.equal(stats.failed,1);
  assert.equal(stats.delivered,0);
  assert.ok(log.indexOf("ROLLBACK")<log.indexOf("FAIL:delivery_failed"));
  assert.ok(!log.includes("ACK"));
});

test("mismatched envelope fails closed without opening destination",async()=>{
  const log=[];
  const source={claim:async()=>[sample({registryEvent:{...registryEvent,eventKey:"changed"}})],
    ack:async()=>{log.push("ACK");return true},
    fail:async(e,code)=>{log.push(code);return true}};
  const stats=await runDeliveryBatch(source,stubDestination(log),
    {workerId:"worker1",batchSize:10,leaseMs:5000});
  assert.equal(stats.failed,1);
  assert.deepEqual(log,["payload_invalid"]);
});

test("expired ACK lease is not counted as delivery",async()=>{
  const log=[];
  const source={claim:async()=>[sample()],
    ack:async()=>false,fail:async()=>true};
  const stats=await runDeliveryBatch(source,stubDestination(log),
    {workerId:"worker1",batchSize:10,leaseMs:5000});
  assert.equal(stats.delivered,0);
  assert.equal(stats.lostLeases,1);
});

test("cross-source evidence mismatch cannot inject a foreign timeline event",async()=>{
  const log=[];
  const forged={
    schemaVersion:"timeline-v1",eventKey:registryEvent.eventKey,kind:"tg_message_published",
    occurredAt:when,observedAt:when,
    entityRefs:registryEvent.entityRefs,
    evidenceRef:{...registryEvent.evidenceRef,sourceId:"tg:message:-10022:43"},
    payload:{},
  };
  const source={
    claim:async()=>[sample({registryEvent,timelineEvent:forged})],
    ack:async()=>{log.push("ACK");return true},
    fail:async(event,code)=>{log.push("FAIL:"+code);return true},
  };
  const stats=await runDeliveryBatch(source,stubDestination(log),
    {workerId:"worker1",batchSize:10,leaseMs:5000});
  assert.equal(stats.failed,1);
  assert.deepEqual(log,["FAIL:payload_invalid"],"destination must never be opened");
});

test("timeline cannot silently replace canonical entity or rewrite observation time",async()=>{
  const foreign={
    ...registryEvent.entityRefs[0],
    canonicalId:formatTokenId("solana","EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  };
  for (const timelineEvent of [
    {schemaVersion:"timeline-v1",eventKey:registryEvent.eventKey,
      kind:"tg_message_published",occurredAt:when,observedAt:when,
      entityRefs:[foreign],evidenceRef:registryEvent.evidenceRef,payload:{}},
    {schemaVersion:"timeline-v1",eventKey:registryEvent.eventKey,
      kind:"tg_message_published",occurredAt:when,observedAt:"2026-10-18T00:01:00Z",
      entityRefs:registryEvent.entityRefs,evidenceRef:registryEvent.evidenceRef,payload:{}},
  ]) {
    const log=[];
    const source={claim:async()=>[sample({registryEvent,timelineEvent})],
      ack:async()=>{log.push("ACK");return true},
      fail:async(e,code)=>{log.push(code);return true}};
    const result=await runDeliveryBatch(source,stubDestination(log),
      {workerId:"worker1",batchSize:10,leaseMs:5000});
    assert.equal(result.failed,1);
    assert.deepEqual(log,["payload_invalid"]);
  }
});


test("slow destination write renews exact lease before using new ACK fencing token",async()=>{
  const log=[];
  const pool=stubDestination(log);
  const original=pool.connect;
  pool.connect=async()=>{
    const client=await original();
    const query=client.query;
    client.query=async(sql,...args)=>{
      if(sql.includes("INSERT INTO intelligence_inbox")){
        await new Promise(resolve=>setTimeout(resolve,850));
      }
      return query(sql,...args);
    };
    return client;
  };
  let lastRenewal="",renewed=0,acked="";
  const source={
    claim:async()=>[sample()],
    renew:async(event)=>{
      renewed++;
      lastRenewal=new Date(Date.now()+3000).toISOString();
      return lastRenewal;
    },
    ack:async event=>{acked=event.leaseUntil;return true},
    fail:async()=>{throw new Error("unexpected NACK")},
  };
  const result=await runDeliveryBatch(source,pool,{
    workerId:"worker1",batchSize:1,leaseMs:1000,
  });
  assert.ok(renewed>=1,"the claim must renew while destination write is slow");
  assert.equal(acked,lastRenewal,"ACK must fence on the latest lease token");
  assert.equal(result.delivered,1);
  assert.equal(result.lostLeases,0);
});

test("failed lease renewal never ACKs a potentially stale claim",async()=>{
  const log=[];
  const pool=stubDestination(log);
  const original=pool.connect;
  pool.connect=async()=>{
    const client=await original();
    const query=client.query;
    client.query=async(sql,...args)=>{
      if(sql.includes("INSERT INTO intelligence_inbox")){
        await new Promise(resolve=>setTimeout(resolve,440));
      }
      return query(sql,...args);
    };
    return client;
  };
  let ackCount=0,nackCount=0,renewCount=0;
  const source={
    claim:async()=>[sample()],
    renew:async()=>{renewCount++;return null},
    ack:async()=>{ackCount++;return true},
    fail:async()=>{nackCount++;return true},
  };
  const result=await runDeliveryBatch(source,pool,{
    workerId:"worker1",batchSize:1,leaseMs:1000,
  });
  assert.equal(renewCount,1);
  assert.equal(ackCount,0);
  assert.equal(nackCount,0);
  assert.equal(result.lostLeases,1);
  assert.equal(result.delivered,0);
});

const verifiedLink=buildVerifiedTokenLinkEvent({
  sourceSystem:"tg",
  sourceEntity:buildEntityRef({
    kind:"source",canonicalId:formatSourceId("tg","12345"),
    firstSeenAt:when,lastSeenAt:when,
  }),
  evidenceRef:buildEvidenceRef({
    sourceKind:"tg_message",sourceAccountId:"12345",messageId:"900",
    observedAt:when,occurredAt:"2026-10-17T23:59:00Z",parserVersion:"tg-mint-verifier-v1",
  }),
  mint:"So11111111111111111111111111111111111111112",
  matchedLiteralMint:"So11111111111111111111111111111111111111112",
  sourceRevisionSha256:"a".repeat(64),
  mintVerification:{
    chainId:"solana-mainnet",method:"spl_mint_account",
    tokenProgram:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    provider:"alchemy-solana-rpc",checkedAt:when,
  },
});
function sampleLink(event=verifiedLink){
  return {...event,id:"991",createdAt:"2026-10-18T00:00:03.000Z",attempts:0,
    leaseOwner:"worker1",leaseUntil:"2026-10-18T00:30:00Z"};
}

test("verified token link commits evidence but does not create an unretractable token timeline",async()=>{
  const log=[];
  const source={
    claim:async()=>[sampleLink()],
    ack:async()=>{log.push("ACK");return true},
    fail:async()=>{log.push("NACK");return true},
  };
  const outcome=await runDeliveryBatch(source,stubDestination(log),{
    workerId:"worker1",batchSize:1,leaseMs:5000,
  });
  assert.equal(outcome.delivered,1);
  assert.equal(outcome.failed,0);
  assert.ok(log.indexOf("COMMIT")<log.indexOf("ACK"));
  assert.ok(!log.some(x=>typeof x==="string" && x.includes("INSERT INTO timeline_events")));
});

test("source/chain/mint/proof tampering is rejected before opening destination",async()=>{
  for(const tampered of [
    {...verifiedLink,payload:{...verifiedLink.payload,
      tokenLink:{...verifiedLink.payload.tokenLink,status:"candidate"}}},
    {...verifiedLink,payload:{...verifiedLink.payload,
      tokenLink:{...verifiedLink.payload.tokenLink,
        canonicalTokenId:formatTokenId("solana","EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")}}},
    {...verifiedLink,payload:{...verifiedLink.payload,
      tokenLink:{...verifiedLink.payload.tokenLink,mintVerification:{
        ...verifiedLink.payload.tokenLink.mintVerification,tokenProgram:"not-a-mint",
      }}}},
    {...verifiedLink,payload:{...verifiedLink.payload,
      registryEvent:{...verifiedLink.payload.registryEvent,eventKey:"wrong"}}},
  ]){
    const log=[];
    const result=await runDeliveryBatch({
      claim:async()=>[sampleLink(tampered)],
      ack:async()=>{log.push("ACK");return true},
      fail:async(_event,code)=>{log.push(code);return true},
    },stubDestination(log),{
      workerId:"worker1",batchSize:1,leaseMs:5000,
    });
    assert.equal(result.delivered,0);
    assert.equal(result.failed,1);
    assert.deepEqual(log,["payload_invalid"]);
  }
});


test("registered V1 delivery adapts with source created_at and preserves knownAt evidence clocks",async()=>{
  const log=[];
  const source={
    claim:async()=>[registeredClaim()],
    ack:async()=>{log.push("ACK");return true;},
    fail:async(_event,code)=>{log.push("FAIL:"+code);return true;},
  };
  const destination={connect:async()=>({
    query:async(sql,params)=>{
      log.push({sql,params});
      return {rows:sql.includes("RETURNING event_key")?[{event_key:registeredEventKey}]:[]};
    },
    release:()=>{},
  })};
  const result=await runDeliveryBatch(source,destination,{
    workerId:"worker1",batchSize:1,leaseMs:5000,
  });
  assert.equal(result.delivered,1);
  assert.equal(result.failed,0);
  const evidenceWrite=log.find(entry=>entry&&typeof entry==="object"&&
    entry.sql.includes("INSERT INTO entity_evidence"));
  assert.ok(evidenceWrite,"the original evidence must reach the established ingest path");
  assert.equal(evidenceWrite.params[7],registeredObservedAt,
    "observedAt/knownAt must remain the source observation time");
  assert.equal(evidenceWrite.params[8],registeredOccurredAt,
    "occurredAt must remain the source occurrence time");
  assert.ok(log.some(entry=>entry==="ACK"));
});

test("claimed outbox rows without created_at are retried as invalid before destination access",async()=>{
  const log=[];
  const claimed=registeredClaim();
  delete claimed.createdAt;
  let opened=0;
  const result=await runDeliveryBatch({
    claim:async()=>[claimed],
    ack:async()=>{log.push("ACK");return true;},
    fail:async(_event,code)=>{log.push("FAIL:"+code);return true;},
  },{connect:async()=>{opened++;return stubDestination(log).connect();}},{
    workerId:"worker1",batchSize:1,leaseMs:5000,
  });
  assert.equal(result.failed,1);
  assert.equal(opened,0);
  assert.deepEqual(log,["FAIL:payload_invalid"]);
});

test("registered V1 delivery derives emittedAt only from source created_at",async()=>{
  const log=[];
  let opened=0;
  const destination={connect:async()=>{opened++;return stubDestination(log).connect();}};
  const source={
    claim:async()=>[registeredClaim(registeredPayload,"2026-10-17T23:00:00.000Z")],
    ack:async()=>{log.push("ACK");return true;},
    fail:async(_event,code)=>{log.push("FAIL:"+code);return true;},
  };
  const result=await runDeliveryBatch(source,destination,{
    workerId:"worker1",batchSize:1,leaseMs:5000,
  });
  assert.equal(result.failed,1);
  assert.equal(opened,0,"invalid source created_at must be rejected before borrowing destination");
  assert.deepEqual(log,["FAIL:payload_invalid"]);
});

test("V2 delivery validates the envelope and binds emittedAt to source created_at",async()=>{
  const log=[];
  const source={
    claim:async()=>[v2Claim()],
    ack:async()=>{log.push("ACK");return true;},
    fail:async(_event,code)=>{log.push("FAIL:"+code);return true;},
  };
  const result=await runDeliveryBatch(source,stubDestination(log),{
    workerId:"worker1",batchSize:1,leaseMs:5000,
  });
  assert.equal(result.delivered,1);
  assert.equal(result.failed,0);
  assert.ok(log.indexOf("COMMIT")<log.indexOf("ACK"));

  const tamperedLog=[];
  const tamperedEnvelope={...registeredV2(),payloadSha256:"0".repeat(64)};
  const tampered=await runDeliveryBatch({
    claim:async()=>[v2Claim(tamperedEnvelope)],
    ack:async()=>{tamperedLog.push("ACK");return true;},
    fail:async(_event,code)=>{tamperedLog.push("FAIL:"+code);return true;},
  },stubDestination(tamperedLog),{
    workerId:"worker1",batchSize:1,leaseMs:5000,
  });
  assert.equal(tampered.failed,1);
  assert.deepEqual(tamperedLog,["FAIL:payload_invalid"]);

  const identityLog=[];
  const wrongIdentity={...v2Claim(),eventKey:registeredEventKey+":other"};
  const identity=await runDeliveryBatch({
    claim:async()=>[wrongIdentity],
    ack:async()=>{identityLog.push("ACK");return true;},
    fail:async(_event,code)=>{identityLog.push("FAIL:"+code);return true;},
  },stubDestination(identityLog),{
    workerId:"worker1",batchSize:1,leaseMs:5000,
  });
  assert.equal(identity.failed,1);
  assert.deepEqual(identityLog,["FAIL:payload_invalid"]);

  const mismatchLog=[];
  const mismatchSource={
    claim:async()=>[v2Claim(registeredV2(),"2026-10-18T00:00:04.000Z")],
    ack:async()=>{mismatchLog.push("ACK");return true;},
    fail:async(_event,code)=>{mismatchLog.push("FAIL:"+code);return true;},
  };
  const mismatch=await runDeliveryBatch(mismatchSource,stubDestination(mismatchLog),{
    workerId:"worker1",batchSize:1,leaseMs:5000,
  });
  assert.equal(mismatch.failed,1);
  assert.deepEqual(mismatchLog,["FAIL:payload_invalid"]);
});

test("V2 unwrapping preserves original occurredAt and observedAt for knownAt",async()=>{
  const log=[];
  const destination={connect:async()=>({
    query:async(sql,params)=>{
      log.push({sql,params});
      return {rows:sql.includes("RETURNING event_key")?[{event_key:registeredEventKey}]:[]};
    },
    release:()=>{},
  })};
  const result=await runDeliveryBatch({
    claim:async()=>[v2Claim()],
    ack:async()=>true,fail:async()=>true,
  },destination,{workerId:"worker1",batchSize:1,leaseMs:5000});
  assert.equal(result.delivered,1);
  const evidenceWrite=log.find(entry=>entry.sql.includes("INSERT INTO entity_evidence"));
  assert.ok(evidenceWrite);
  assert.equal(evidenceWrite.params[7],registeredObservedAt,
    "V2 emittedAt must never replace source observedAt/knownAt");
  assert.equal(evidenceWrite.params[8],registeredOccurredAt,
    "V2 normalization must preserve source occurredAt");
});

test("V2 replay is duplicate only for the same envelope hash; changed hash is a collision",async()=>{
  const log=[];
  const destination=statefulInboxDestination(log);
  const firstSource={
    claim:async()=>[v2Claim()],
    ack:async()=>true,fail:async()=>true,
  };
  const first=await runDeliveryBatch(firstSource,destination,{
    workerId:"worker1",batchSize:1,leaseMs:5000,
  });
  assert.equal(first.delivered,1);

  const replay=await runDeliveryBatch(firstSource,destination,{
    workerId:"worker1",batchSize:1,leaseMs:5000,
  });
  assert.equal(replay.duplicates,1);
  assert.equal(replay.failed,0);

  const collisionLog=[];
  const collision=await runDeliveryBatch({
    claim:async()=>[v2Claim(registeredV2("different-build"))],
    ack:async()=>{collisionLog.push("ACK");return true;},
    fail:async(_event,code)=>{collisionLog.push("FAIL:"+code);return true;},
  },destination,{
    workerId:"worker1",batchSize:1,leaseMs:5000,
  });
  assert.equal(collision.failed,1);
  assert.deepEqual(collisionLog,["FAIL:identity_collision"],
    "same source identity with a changed canonical envelope hash must fail as a collision, not ACK");
});


test("V1 to V2 same-key replay fails closed until cross-version inbox reconciliation is designed",async()=>{
  const log=[];
  const destination=statefulInboxDestination(log);
  const v1=await runDeliveryBatch({
    claim:async()=>[registeredClaim()],
    ack:async()=>true,fail:async()=>true,
  },destination,{
    workerId:"worker1",batchSize:1,leaseMs:5000,
  });
  assert.equal(v1.delivered,1);

  const collisionLog=[];
  const v2=await runDeliveryBatch({
    claim:async()=>[v2Claim()],
    ack:async()=>{collisionLog.push("ACK");return true;},
    fail:async(_event,code)=>{collisionLog.push("FAIL:"+code);return true;},
  },destination,{
    workerId:"worker1",batchSize:1,leaseMs:5000,
  });
  assert.equal(v2.failed,1);
  assert.deepEqual(collisionLog,["FAIL:identity_collision"],
    "legacy registry-only inbox hash must not be mistaken for a full V2 envelope hash");
});
