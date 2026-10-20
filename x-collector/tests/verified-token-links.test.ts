import {test} from "node:test";
import assert from "node:assert/strict";
import type {PoolClient} from "pg";
import {PGlite} from "@electric-sql/pglite";
import fs from "node:fs/promises";
import {
  buildVerifiedXTweetTokenLinkOutboxEvent,
  emitXVerifiedTokenLinkOutbox,xVerifiedTokenLinksEnabled,
} from "../src/collector/persistence/verified-token-links";

const mint="So11111111111111111111111111111111111111112";
const text="Verified Solana mint: "+mint+" (other private context must not leave X)";
const proof={
  tokenProgram:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  provider:"alchemy-solana-rpc" as const,
  checkedAt:new Date("2026-10-19T23:50:00Z"),
};
const input={
  tweetId:"1234567890123456789",authorId:"99999999999999",text,mint,
  observedAt:new Date("2026-10-20T00:00:00Z"),
  postedAt:new Date("2026-10-19T23:00:00Z"),
  mintVerification:proof,
};

test("X mint producer requires both source and token-link opt-ins",()=>{
  assert.equal(xVerifiedTokenLinksEnabled({}),false);
  assert.equal(xVerifiedTokenLinksEnabled({X_INTELLIGENCE_TOKEN_LINKS_ENABLED:"true"}),false);
  assert.equal(xVerifiedTokenLinksEnabled({X_INTELLIGENCE_OUTBOX_ENABLED:"true"}),false);
  assert.equal(xVerifiedTokenLinksEnabled({
    X_INTELLIGENCE_OUTBOX_ENABLED:"true",X_INTELLIGENCE_TOKEN_LINKS_ENABLED:"true",
  }),true);
});

test("X verified mint proof is historical evidence, not an active timeline row",()=>{
  const e=buildVerifiedXTweetTokenLinkOutboxEvent(input);
  assert.equal(e.eventKind,"token_link_verified");
  assert.equal(e.schemaVersion,"token-link-v1");
  assert.equal(e.payload.registryEvent.evidenceRef.sourceId,"x:tweet:"+input.tweetId);
  assert.equal(e.payload.tokenLink.canonicalTokenId,"solana:"+mint);
  assert.deepEqual(e.payload.registryEvent.entityRefs.map(x=>x.kind),["author","token"]);
  assert.equal(Object.hasOwn(e.payload,"timelineEvent"),false);
  assert.ok(!JSON.stringify(e).includes(input.text));
  assert.deepEqual(buildVerifiedXTweetTokenLinkOutboxEvent(input),e);
  assert.notEqual(buildVerifiedXTweetTokenLinkOutboxEvent({
    ...input,text:text+" updated",
  }).eventKey,e.eventKey);
});

test("never upgrade plain tweet text, ticker or task mint without RPC proof",()=>{
  for(const change of [
    {mint:"not-a-mint"},{text:"$SOL"},
    {text:"prefixA"+mint+"Zsuffix"},
    {authorId:"@handle"},{tweetId:"0"},
    {mintVerification:{...proof,tokenProgram:"NotAnSPLMint"}},
    {mintVerification:{...proof,provider:"untrusted-provider"}},
    {mintVerification:{...proof,checkedAt:new Date("2026-10-20T00:01:00Z")}},
  ])assert.throws(()=>buildVerifiedXTweetTokenLinkOutboxEvent({...input,...change} as typeof input));
});

test("X verified link writer is offline by default and uses caller transaction only",async()=>{
  const oldOut=process.env.X_INTELLIGENCE_OUTBOX_ENABLED;
  const oldLink=process.env.X_INTELLIGENCE_TOKEN_LINKS_ENABLED;
  const queries:{sql:string;values:unknown[]}[]=[];
  const tx={query:async(sql:string,values:unknown[]=[])=>{
    queries.push({sql,values});return {rows:[],rowCount:1};
  }} as unknown as PoolClient;
  try{
    delete process.env.X_INTELLIGENCE_OUTBOX_ENABLED;
    delete process.env.X_INTELLIGENCE_TOKEN_LINKS_ENABLED;
    assert.equal(await emitXVerifiedTokenLinkOutbox(tx,input),false);
    assert.equal(queries.length,0);
    process.env.X_INTELLIGENCE_OUTBOX_ENABLED="true";
    process.env.X_INTELLIGENCE_TOKEN_LINKS_ENABLED="true";
    assert.equal(await emitXVerifiedTokenLinkOutbox(tx,input),true);
    assert.equal(queries.length,1);
    assert.match(queries[0]!.sql,/INSERT INTO outbox_events/);
    const event=JSON.parse(String(queries[0]!.values[4]));
    assert.equal(event.tokenLink.status,"verified");
    assert.equal(JSON.stringify(event).includes(text),false);
  }finally{
    if(oldOut===undefined)delete process.env.X_INTELLIGENCE_OUTBOX_ENABLED;
    else process.env.X_INTELLIGENCE_OUTBOX_ENABLED=oldOut;
    if(oldLink===undefined)delete process.env.X_INTELLIGENCE_TOKEN_LINKS_ENABLED;
    else process.env.X_INTELLIGENCE_TOKEN_LINKS_ENABLED=oldLink;
  }
});

test("X source verified link is atomic and deduplicated in PGlite",async()=>{
  const pg=new PGlite();
  const prevOut=process.env.X_INTELLIGENCE_OUTBOX_ENABLED;
  const prevLink=process.env.X_INTELLIGENCE_TOKEN_LINKS_ENABLED;
  const tx={query:(sql:string,params?:unknown[])=>pg.query(sql,params)} as unknown as PoolClient;
  try{
    const ddl=await fs.readFile("migrations/050_intelligence_source_outbox.sql","utf8");
    await pg.exec(ddl);
    process.env.X_INTELLIGENCE_OUTBOX_ENABLED="true";
    process.env.X_INTELLIGENCE_TOKEN_LINKS_ENABLED="true";
    await pg.exec("BEGIN");
    assert.equal(await emitXVerifiedTokenLinkOutbox(tx,input),true);
    await pg.exec("ROLLBACK");
    const empty=await pg.query<{n:string}>("SELECT count(*)::text AS n FROM outbox_events");
    assert.equal(empty.rows[0]?.n,"0");
    await pg.exec("BEGIN");
    assert.equal(await emitXVerifiedTokenLinkOutbox(tx,input),true);
    assert.equal(await emitXVerifiedTokenLinkOutbox(tx,input),true);
    await pg.exec("COMMIT");
    const one=await pg.query<{n:string}>("SELECT count(*)::text AS n FROM outbox_events");
    assert.equal(one.rows[0]?.n,"1");
  }finally{
    if(prevOut===undefined)delete process.env.X_INTELLIGENCE_OUTBOX_ENABLED;
    else process.env.X_INTELLIGENCE_OUTBOX_ENABLED=prevOut;
    if(prevLink===undefined)delete process.env.X_INTELLIGENCE_TOKEN_LINKS_ENABLED;
    else process.env.X_INTELLIGENCE_TOKEN_LINKS_ENABLED=prevLink;
    await pg.close();
  }
});
