import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTgTokenLinksInvalidatedOutboxEvent,emitTgTokenLinksInvalidation,
} from "../src/persistence/outbox.js";

const input={
  peerId:"12345",messageId:111,reason:"edited" as const,
  sourceRevisionSha256:"a".repeat(64),
  observedAt:new Date("2026-10-20T01:10:00Z"),
  postedAt:new Date("2026-10-19T22:00:00Z"),
};

test("edit/delete tombstone revokes entire source evidence, never just one mint",()=>{
  for(const reason of ["edited","deleted"] as const){
    const event=buildTgTokenLinksInvalidatedOutboxEvent({...input,reason});
    assert.equal(event.eventKind,"token_links_invalidated");
    assert.equal(event.schemaVersion,"token-link-v1");
    assert.equal(event.payload.registryEvent.entityRefs.length,1);
    assert.equal(event.payload.registryEvent.entityRefs[0]!.kind,"source");
    assert.equal(event.payload.registryEvent.evidenceRef.sourceId,"tg:message:12345:111");
    assert.equal(event.payload.tokenLinksInvalidation.status,"invalidated");
    assert.equal(event.payload.tokenLinksInvalidation.reason,reason);
    assert.equal(Object.hasOwn(event.payload,"timelineEvent"),false);
    assert.ok(!JSON.stringify(event).includes("private_message_body"));
    assert.deepEqual(buildTgTokenLinksInvalidatedOutboxEvent({...input,reason}),event);
  }
});

test("malformed, missing stable peer and invalid reason fail closed",()=>{
  for(const changed of [
    {peerId:null},{peerId:"@channel"},{messageId:0},
    {reason:"other"},{sourceRevisionSha256:"bad"},
    {observedAt:new Date("not-a-time")},
  ])assert.throws(()=>buildTgTokenLinksInvalidatedOutboxEvent({...input,...changed} as typeof input));
});

test("invalidation is off by default and uses caller transaction only",async()=>{
  const out=process.env.TG_INTELLIGENCE_OUTBOX_ENABLED,links=process.env.TG_INTELLIGENCE_TOKEN_LINKS_ENABLED;
  const queries:{sql:string;values:unknown[]}[]=[];
  const tx={query:async(sql:string,values:unknown[]=[])=>{
    queries.push({sql,values});
    if(sql.includes("SELECT peer_id"))return {rows:[{peer_id:"12345"}],rowCount:1};
    return {rows:[],rowCount:1};
  }};
  try{
    delete process.env.TG_INTELLIGENCE_OUTBOX_ENABLED;
    delete process.env.TG_INTELLIGENCE_TOKEN_LINKS_ENABLED;
    const {peerId,...body}=input;
    assert.equal(await emitTgTokenLinksInvalidation(tx as never,"source-local-id",body),false);
    assert.equal(queries.length,0);
    process.env.TG_INTELLIGENCE_OUTBOX_ENABLED="true";
    process.env.TG_INTELLIGENCE_TOKEN_LINKS_ENABLED="true";
    assert.equal(await emitTgTokenLinksInvalidation(tx as never,"source-local-id",body),true);
    assert.equal(queries.length,2);
    assert.match(queries[1]!.sql,/INSERT INTO outbox_events/);
    const payload=JSON.parse(String(queries[1]!.values[4]));
    assert.equal(payload.tokenLinksInvalidation.reason,"edited");
    assert.equal(payload.registryEvent.evidenceRef.sourceId,"tg:message:12345:111");
  }finally{
    if(out===undefined)delete process.env.TG_INTELLIGENCE_OUTBOX_ENABLED;
    else process.env.TG_INTELLIGENCE_OUTBOX_ENABLED=out;
    if(links===undefined)delete process.env.TG_INTELLIGENCE_TOKEN_LINKS_ENABLED;
    else process.env.TG_INTELLIGENCE_TOKEN_LINKS_ENABLED=links;
  }
});
