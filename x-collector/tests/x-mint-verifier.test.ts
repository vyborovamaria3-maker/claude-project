import test from "node:test";
import assert from "node:assert/strict";
import {
  verifySolanaMintViaAlchemy,TOKEN_PROGRAM,TOKEN_2022_PROGRAM,
} from "../src/collector/persistence/solana-mint-proof";
import {
  parseMintVerificationArgs,verifyXTokenLinksOnce,
} from "../scripts/verify-x-token-links";
import {
  buildXTokenLinksInvalidatedOutboxEvent,
} from "../src/collector/persistence/verified-token-links";

const mint="So11111111111111111111111111111111111111112";
const timestamp="2026-10-20T01:50:00.000Z";
function mockAccount({owner=TOKEN_PROGRAM,type="mint",initialized=true,decimals=9,slot=123,program="spl-token"}={}){
  return {jsonrpc:"2.0",id:1,result:{context:{slot},value:{
    owner,executable:false,data:{program,parsed:{type,info:{isInitialized:initialized,decimals}}}
  }}};
}
function stub(body:unknown,status=200,log?:{request:unknown;url:string}[]){
  return (async(url:string,init:RequestInit)=>{
    log?.push({url,request:JSON.parse(String(init.body))});
    return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
  }) as typeof fetch;
}

test("Alchemy jsonParsed mint proof requires initialized SPL Mint, never mere base58 address",async()=>{
  const requests:{request:unknown;url:string}[]=[];
  const proof=await verifySolanaMintViaAlchemy("https://solana.example/rpc",mint,
    stub(mockAccount(),200,requests));
  assert.equal(proof?.tokenProgram,TOKEN_PROGRAM);
  assert.equal(proof?.provider,"alchemy-solana-rpc");
  assert.equal(proof?.slot,123);
  assert.equal(requests.length,1);
  assert.equal((requests[0]!.request as {method:string}).method,"getAccountInfo");
  const params=(requests[0]!.request as {params:[string,{encoding:string;commitment:string}]}).params;
  assert.equal(params[0],mint);
  assert.equal(params[1].encoding,"jsonParsed");
  assert.equal(params[1].commitment,"confirmed");

  for(const invalid of [
    mockAccount({type:"account"}),
    mockAccount({initialized:false}),
    mockAccount({owner:"11111111111111111111111111111111"}),
    mockAccount({program:"wrong-program"}),
    mockAccount({decimals:31}),
    mockAccount({type:"mint",slot:-1}),
  ]){
    if(invalid.result.context.slot<0)
      await assert.rejects(verifySolanaMintViaAlchemy("https://solana.example",mint,stub(invalid)));
    else assert.equal(await verifySolanaMintViaAlchemy("https://solana.example",mint,stub(invalid)),null);
  }
  assert.equal((await verifySolanaMintViaAlchemy("https://solana.example",mint,
    stub(mockAccount({owner:TOKEN_2022_PROGRAM,program:"spl-token-2022"}))))?.tokenProgram,
    TOKEN_2022_PROGRAM);
  const missing=mockAccount();
  (missing.result as {value:unknown}).value=null;
  assert.equal(await verifySolanaMintViaAlchemy("https://solana.example",mint,stub(missing)),null);
});

test("mint verification handles RPC outages without printing or trusting provider errors",async()=>{
  await assert.rejects(verifySolanaMintViaAlchemy("http://unsafe.example",mint,stub(mockAccount())));
  await assert.rejects(verifySolanaMintViaAlchemy("https://u:p@unsafe.example",mint,stub(mockAccount())));
  await assert.rejects(verifySolanaMintViaAlchemy("https://solana.example",mint,stub({},500)),
    /mint_rpc_transport_failed/);
  await assert.rejects(verifySolanaMintViaAlchemy("https://solana.example",mint,
    stub({error:{message:"private rpc key leaked"}})),/mint_rpc_response_invalid/);
  await assert.rejects(verifySolanaMintViaAlchemy("https://solana.example","invalid",stub(mockAccount())));
});

test("bounded CLI rejects unbounded RPC budgets and offers dry-run without secrets",()=>{
  assert.deepEqual(parseMintVerificationArgs(["--cursor=123","--limit=5","--max-rpc=3"]),{
    cursor:"123",limit:5,maxRpc:3,execute:false,help:false,
  });
  for(const args of [
    ["--limit=50000"],["--max-rpc=0"],["--cursor=@handle"],
    ["--cursor=-1"],["--limit=x"],["--execute","--unknown"],
  ])assert.throws(()=>parseMintVerificationArgs(args));
});

test("dry run enumerates address candidates without RPC or destination writes",async()=>{
  let reads=0,rpcs=0,writes=0;
  const result=await verifyXTokenLinksOnce(parseMintVerificationArgs(["--limit=2"]),{
    read:async()=>{reads++;return [{tweet_id:"101",author_id:"999",text:"Token: "+mint,posted_at:null},
      {tweet_id:"102",author_id:null,text:"Token: "+mint,posted_at:null}]},
    verify:async()=>{rpcs++;return null},
    emit:async()=>{writes++;return true},
  });
  assert.equal(reads,1);assert.equal(rpcs,0);assert.equal(writes,0);
  assert.equal(result.mode,"dry_run");assert.equal(result.candidates,1);
  assert.equal(result.skipped,1);assert.equal(result.nextCursor,"102");
});

test("execute requires three opt-ins and reuses proof inside bounded RPC budget",async()=>{
  const originals=["X_INTELLIGENCE_OUTBOX_ENABLED","X_INTELLIGENCE_TOKEN_LINKS_ENABLED",
    "X_INTELLIGENCE_MINT_VERIFY_ENABLED","ALCHEMY_SOLANA_RPC_URL"]
    .map(key=>[key,process.env[key]] as const);
  try{
    process.env.X_INTELLIGENCE_OUTBOX_ENABLED="true";
    process.env.X_INTELLIGENCE_TOKEN_LINKS_ENABLED="true";
    process.env.X_INTELLIGENCE_MINT_VERIFY_ENABLED="true";
    process.env.ALCHEMY_SOLANA_RPC_URL="https://solana.example";
    let rpcs=0,writes=0;
    const result=await verifyXTokenLinksOnce(
      parseMintVerificationArgs(["--execute","--limit=2","--max-rpc=1"]),{
        read:async()=>[{tweet_id:"101",author_id:"999",text:"Token: "+mint,posted_at:null},
          {tweet_id:"102",author_id:"888",text:"Also "+mint,posted_at:null}],
        verify:async()=>{rpcs++;return {provider:"alchemy-solana-rpc",
          checkedAt:new Date(timestamp),tokenProgram:TOKEN_PROGRAM,slot:100}},
        emit:async()=>{writes++;return true},
      },
    );
    assert.equal(rpcs,1);
    assert.equal(writes,2);
    assert.equal(result.emitted,2);
    assert.equal(result.requests,1);
    assert.equal(result.nextCursor,"102");
    process.env.X_INTELLIGENCE_MINT_VERIFY_ENABLED="false";
    await assert.rejects(verifyXTokenLinksOnce(parseMintVerificationArgs(["--execute"]),{
      read:async()=>[],
    }),/x_mint_verification_explicit_opt_in_required/);
  }finally{
    for(const [key,value] of originals){
      if(value===undefined)delete process.env[key];
      else process.env[key]=value;
    }
  }
});

test("source-wide X edit invalidation is revisioned, token-agnostic and contains no text",()=>{
  const sample={
    tweetId:"101",authorId:"999",reason:"edited" as const,
    sourceRevisionSha256:"b".repeat(64),
    observedAt:new Date(timestamp),postedAt:new Date("2026-10-19T23:00:00Z"),
  };
  const first=buildXTokenLinksInvalidatedOutboxEvent(sample);
  assert.equal(first.eventKind,"token_links_invalidated");
  assert.equal(first.payload.registryEvent.evidenceRef.sourceId,"x:tweet:101");
  assert.equal(first.payload.registryEvent.entityRefs.length,1);
  assert.equal(first.payload.tokenLinksInvalidation.reason,"edited");
  assert.ok(!Object.hasOwn(first.payload,"timelineEvent"));
  assert.deepEqual(buildXTokenLinksInvalidatedOutboxEvent(sample),first);
  assert.notEqual(buildXTokenLinksInvalidatedOutboxEvent({
    ...sample,sourceRevisionSha256:"c".repeat(64),
  }).eventKey,first.eventKey);
});
