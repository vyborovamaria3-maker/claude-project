import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildVerifiedTgTokenLinkOutboxEvent,telegramVerifiedTokenLinksEnabled,
  emitVerifiedTgTokenLinkOutbox,
} from "../src/persistence/outbox.js";

const mint="So11111111111111111111111111111111111111112";
const program="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const now=new Date("2026-10-20T01:00:00.000Z");
const text="Confirmed address: "+mint+" should remain private source text.";
const revision=createHash("sha256").update(JSON.stringify([
  text,"2026-10-19T22:00:00.000Z",null,
])).digest("hex");
const args={
  peerId:"12345678",messageId:"42",text,mint,
  tokenProgram:program,provider:"alchemy-solana-rpc" as const,
  sourceRevisionSha256:revision,
  observedAt:now,postedAt:new Date("2026-10-19T22:00:00Z"),
};

test("verified token emission requires both opt-ins",()=>{
  assert.equal(telegramVerifiedTokenLinksEnabled({}),false);
  assert.equal(telegramVerifiedTokenLinksEnabled({
    TG_INTELLIGENCE_TOKEN_LINKS_ENABLED:"true",
  }),false);
  assert.equal(telegramVerifiedTokenLinksEnabled({
    TG_INTELLIGENCE_OUTBOX_ENABLED:"true",
  }),false);
  assert.equal(telegramVerifiedTokenLinksEnabled({
    TG_INTELLIGENCE_OUTBOX_ENABLED:"true",
    TG_INTELLIGENCE_TOKEN_LINKS_ENABLED:"true",
  }),true);
});

test("TG verified address is evidence-only; no message text and no timeline promotion",()=>{
  const e=buildVerifiedTgTokenLinkOutboxEvent(args);
  assert.equal(e.eventKind,"token_link_verified");
  assert.equal(e.schemaVersion,"token-link-v1");
  assert.equal(e.payload.tokenLink.canonicalTokenId,"solana:"+mint);
  assert.equal(e.payload.tokenLink.mintVerification.provider,"alchemy-solana-rpc");
  assert.equal(e.payload.registryEvent.evidenceRef.sourceId,"tg:message:12345678:42");
  assert.deepEqual(e.payload.registryEvent.entityRefs.map(x=>x.kind),["source","token"]);
  assert.equal(Object.hasOwn(e.payload,"timelineEvent"),false);
  assert.equal(JSON.stringify(e).includes(text),false);
  assert.equal(JSON.stringify(e).includes("should remain private"),false);
  assert.equal(buildVerifiedTgTokenLinkOutboxEvent(args).eventKey,e.eventKey);
  assert.notEqual(buildVerifiedTgTokenLinkOutboxEvent({
    ...args,sourceRevisionSha256:"b".repeat(64),
  }).eventKey,e.eventKey);
});

test("reject fabricated on-chain verification, ticker and non-literal mint mentions",()=>{
  for(const change of [
    {peerId:null},{peerId:"@channel"},{mint:"invalid"},
    {text:"Only ticker $SOL with no verified literal address"},
    {text:"A"+mint+"Z"},
    {tokenProgram:"TokenAccountNotMint"},{provider:"unreviewed-rpc"},
    {sourceRevisionSha256:"not-a-sha256"},{messageId:"-1"},
    {postedAt:new Date("not a date")},
  ])assert.throws(()=>buildVerifiedTgTokenLinkOutboxEvent({...args,...change} as typeof args));
});

test("verified TG Outbox emission is transaction-owned and opt-in",async()=>{
  const priorOutbox=process.env.TG_INTELLIGENCE_OUTBOX_ENABLED;
  const priorLinks=process.env.TG_INTELLIGENCE_TOKEN_LINKS_ENABLED;
  const commands:{sql:string;values:unknown[]}[]=[];
  const tx={query:async(sql:string,values:unknown[]=[])=>{
    commands.push({sql,values});
    return {rows:[],rowCount:1};
  }};
  try{
    delete process.env.TG_INTELLIGENCE_OUTBOX_ENABLED;
    delete process.env.TG_INTELLIGENCE_TOKEN_LINKS_ENABLED;
    assert.equal(await emitVerifiedTgTokenLinkOutbox(tx as never,args),false);
    assert.equal(commands.length,0);
    process.env.TG_INTELLIGENCE_OUTBOX_ENABLED="true";
    process.env.TG_INTELLIGENCE_TOKEN_LINKS_ENABLED="true";
    assert.equal(await emitVerifiedTgTokenLinkOutbox(tx as never,args),true);
    assert.equal(commands.length,1);
    assert.match(commands[0]!.sql,/INSERT INTO outbox_events/);
    const event=JSON.parse(String(commands[0]!.values[4]));
    assert.equal(event.tokenLink.status,"verified");
    assert.equal(event.registryEvent.eventKind,"token_link_verified");
    assert.equal(JSON.stringify(event).includes(text),false);
  }finally{
    if(priorOutbox===undefined)delete process.env.TG_INTELLIGENCE_OUTBOX_ENABLED;
    else process.env.TG_INTELLIGENCE_OUTBOX_ENABLED=priorOutbox;
    if(priorLinks===undefined)delete process.env.TG_INTELLIGENCE_TOKEN_LINKS_ENABLED;
    else process.env.TG_INTELLIGENCE_TOKEN_LINKS_ENABLED=priorLinks;
  }
});

test("verified mint link supports native signed Telegram channel peer ID",()=>{
  const event=buildVerifiedTgTokenLinkOutboxEvent({...args,peerId:"-100123456789"});
  assert.equal(event.payload.registryEvent.evidenceRef.sourceId,
    "tg:message:-100123456789:42");
  assert.equal(event.payload.registryEvent.entityRefs[0]!.canonicalId,
    "tg:source:-100123456789");
});
