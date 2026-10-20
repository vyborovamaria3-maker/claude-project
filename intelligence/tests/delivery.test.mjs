import test from "node:test";
import assert from "node:assert/strict";
import {buildEvidenceRef,buildEntityRef,formatTokenId,formatSourceId,buildVerifiedTokenLinkEvent} from "@claude-project/contracts";
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
    schemaVersion:"tg-v1",payload,attempts:0,leaseOwner:"worker1",leaseUntil:"2026-10-18T00:30:00Z"};
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
  return {...event,id:"991",attempts:0,
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
