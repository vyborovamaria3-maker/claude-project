import test from "node:test";
import assert from "node:assert/strict";
import {request as httpRequest} from "node:http";
import {randomBytes} from "node:crypto";
import pg from "pg";
import {readFile} from "node:fs/promises";
import {
  buildEntityRef,buildEvidenceRef,buildTimelineEvent,
  buildVerifiedTokenLinkEvent,buildTokenLinksInvalidatedEvent,
  formatTokenId,formatSourceId,
} from "@claude-project/contracts";
import {
  ingestRegistryEvent,ingestTimelineEvent,ingestTokenLinkObservation,
} from "../dist/index.js";
import {createIntelligenceApi,checkApiReadiness,validateApiToken} from "../api/server.mjs";
import {apiConfiguration} from "../api/start.mjs";
import {parseApiRequest} from "../api/routes.mjs";

const token="f".repeat(43);
const mint="So11111111111111111111111111111111111111112";
const id=formatTokenId("solana",mint);
const at="2026-10-20T03:30:00.000Z";
const known="2026-10-20T03:00:00.000Z";
const occurred="2026-10-19T22:00:00.000Z";
const base="/api/intelligence/v1/tokens/"+encodeURIComponent(id);
const window="occurredBefore="+encodeURIComponent(occurred)+"&knownAt="+encodeURIComponent(known);

function fakePool(){
  const logs=[];
  return {
    logs,
    async query(sql,params){
      logs.push({sql,params});
      if(sql==="SELECT 1 AS ok")return {rows:[{ok:1}]};
      if(sql.includes("FROM timeline_events")){
        return {rows:[{
          source_system:"x",timeline_kind:"tweet_published",
          event_key:"SECRET-event",payload:{text:"SECRET tweet body"},
          evidence_source_id:"x:tweet:1024",
          occurred_at:new Date(occurred),observed_at:new Date("2026-10-20T02:00:00Z"),
        }]};
      }
      if(sql.includes("WITH latest AS")){
        return {rows:[{
          source_system:"tg",evidence_source_id:"tg:message:-100123:42",
          canonical_token_id:id,occurred_at:new Date(occurred),
          observed_at:new Date("2026-10-20T02:00:00Z"),
          source_revision_sha256:"a".repeat(64),
          event_key:"SECRET-revision",details:{apiKey:"SECRET-private-provider-data"},
        }]};
      }
      throw new Error("postgres://secret:password@private.internal");
    },
  };
}
async function withServer(pool,fn,opts={}){
  const server=createIntelligenceApi({token,pool,now:()=>new Date(at),...opts});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{return await fn("http://127.0.0.1:"+server.address().port,server)}
  finally{await new Promise(resolve=>server.close(resolve))}
}
function headers(extra={}){
  return {"Authorization":"Bearer "+token,...extra};
}

test("API config refuses public launch, short tokens and missing destination",()=>{
  assert.throws(()=>apiConfiguration({}),/api_explicit_opt_in_required/);
  assert.throws(()=>apiConfiguration({
    INTELLIGENCE_API_ENABLED:"true",INTELLIGENCE_API_TOKEN:"small",
  }),/api_token_configuration_invalid/);
  assert.throws(()=>apiConfiguration({
    INTELLIGENCE_API_ENABLED:"true",INTELLIGENCE_API_TOKEN:token,
  }),/intelligence_database_config_required/);
  assert.deepEqual(apiConfiguration({
    INTELLIGENCE_API_ENABLED:"true",INTELLIGENCE_API_TOKEN:token,
    INTELLIGENCE_DATABASE_URL:"postgres://localhost/test",
  }),{
    token,connectionString:"postgres://localhost/test",port:3182,
  });
  assert.throws(()=>validateApiToken("Bearer "+token));
});

test("strict token/time/query validation rejects aliases, encoded slashes, future leakage and duplicate filters",()=>{
  const now=new Date(at);
  assert.equal(parseApiRequest("/api/intelligence/v1/health",now).kind,"health");
  assert.equal(parseApiRequest(base+"/timeline?"+window+"&limit=3",now).limit,3);
  for(const route of [
    base+"/timeline?"+window+"&limit=101",
    base+"/timeline?"+window+"&limit=0",
    base+"/timeline?"+window+"&limit=foo",
    base+"/timeline?"+window+"&limit=2&limit=4",
    base+"/timeline?"+window+"&unknown=1",
    base+"/timeline?knownAt="+encodeURIComponent(known),
    base+"/links?"+window.replace(known,at.replace("03:30","23:30")),
    base+"/timeline?occurredBefore="+encodeURIComponent(at)+"&knownAt="+encodeURIComponent(known),
    "/api/intelligence/v1/tokens/SOL/timeline?"+window,
    "/api/intelligence/v1/tokens/solana%3A%2Fprivate/timeline?"+window,
    "/api/intelligence/v1/health?token="+token,
  ])assert.throws(()=>parseApiRequest(route,now),TypeError);
  assert.equal(parseApiRequest("/api/intelligence/v1/nope",now),null);
});

test("HTTP API enforces Bearer, no cookie/CORS, safe responses and read-only query limits",async()=>{
  const pool=fakePool();
  await withServer(pool,async origin=>{
    for(const reqHeaders of [{},{Cookie:"session=do-not-trust"},
      {Authorization:"Bearer "+token.slice(0,-1)+"g"}]){
      const r=await fetch(origin+base+"/timeline?"+window,{headers:reqHeaders});
      assert.equal(r.status,401);
      assert.equal(r.headers.get("access-control-allow-origin"),null);
      assert.equal(r.headers.get("cache-control"),"no-store, private");
    }
    const opt=await fetch(origin+base+"/timeline?"+window,{
      method:"OPTIONS",headers:headers(),
    });
    assert.equal(opt.status,405);
    const good=await fetch(origin+base+"/timeline?"+window+"&limit=1",{
      headers:headers(),
    });
    assert.equal(good.status,200);
    const body=await good.json();
    assert.equal(body.schemaVersion,"token-intelligence-v1");
    assert.equal(body.historicalCompleteness,"unknown");
    assert.equal(body.items.length,1);
    assert.equal(body.items[0].evidenceId,"x:tweet:1024");
    assert.equal(body.items[0].observedAt,"2026-10-20T02:00:00.000Z");
    assert.ok(!JSON.stringify(body).includes("SECRET"));
    assert.ok(!Object.hasOwn(body.items[0],"payload"));
    const link=await fetch(origin+base+"/links?"+window,{headers:headers()});
    assert.equal(link.status,200);
    const linked=await link.json();
    assert.equal(linked.items[0].evidenceId,"tg:message:-100123:42");
    assert.equal(linked.linkState,"active_as_known_at");
    assert.ok(!JSON.stringify(linked).includes("SECRET"));
    const ready=await fetch(origin+"/api/intelligence/v1/health",{headers:headers()});
    assert.equal(ready.status,200);
    assert.equal((await ready.json()).sourceCollectorsChecked,false);
    assert.equal(pool.logs.length,3);
    assert.equal(pool.logs[0].params[0],id);
    assert.equal(pool.logs[0].params[3],2,"fetch limit+1 for truncation detection");
  });
});

test("HTTP HTTP parser refuses duplicated Authorization without evaluating SQL",async()=>{
  const pool=fakePool();
  await withServer(pool,async(origin)=>{
    const url=new URL(origin+base+"/timeline?"+window);
    const result=await new Promise((resolve,reject)=>{
      const req=httpRequest({
        hostname:url.hostname,port:url.port,path:url.pathname+url.search,method:"GET",
        headers:["Authorization","Bearer "+token,"Authorization","Bearer "+token],
      },res=>{
        res.resume();
        res.on("end",()=>resolve(res.statusCode));
      });
      req.on("error",reject);req.end();
    });
    assert.ok([400,401].includes(result),"duplicate auth is never accepted");
    assert.equal(pool.logs.length,0);
  });
});

test("database failures only return stable code; strict rate and capacity are bounded",async()=>{
  const pool={query:async()=>{throw new Error("postgres://admin:secret@host X session")}};
  await withServer(pool,async origin=>{
    const res=await fetch(origin+"/api/intelligence/v1/health",{headers:headers()});
    assert.equal(res.status,503);
    assert.deepEqual(await res.json(),{error:"intelligence_database_unavailable"});
  });
  const read=fakePool();
  await withServer(read,async origin=>{
    const first=await fetch(origin+"/api/intelligence/v1/health",{headers:headers()});
    assert.equal(first.status,200);
    const second=await fetch(origin+"/api/intelligence/v1/health",{headers:headers()});
    assert.equal(second.status,429);
    assert.equal(second.headers.get("retry-after"),"60");
    assert.equal(read.logs.length,1);
  },{requestsPerMinute:1});
});

test("readiness requires destination 001/002/004; no fallback to source databases",async()=>{
  const failed={query:async()=>({rows:[{
    inbox:true,timeline:true,entities:true,links:false,
  }]})};
  await assert.rejects(checkApiReadiness(failed),/migrations_001_002_004_required/);
  await assert.doesNotReject(checkApiReadiness({query:async()=>({rows:[{
    inbox:true,timeline:true,entities:true,links:true,
  }]})}));
});

test("real isolated PostgreSQL: token timeline and retraction-aware links are safe as-of",{
  skip:!process.env.INTELLIGENCE_TEST_DB_URL,
},async()=>{
  const url=process.env.INTELLIGENCE_TEST_DB_URL;
  const schema="api_v1_"+randomBytes(5).toString("hex");
  const admin=new pg.Client({connectionString:url});
  let pool;
  await admin.connect();
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');
    await admin.query('SET search_path TO "'+schema+'"');
    for(const file of ["001_entity_registry.sql","002_timeline.sql","004_token_link_observations.sql"]){
      await admin.query(await readFile(new URL("../migrations/"+file,import.meta.url),"utf8"));
    }
    pool=new pg.Pool({connectionString:url,options:"-c search_path="+schema,max:3});
    await checkApiReadiness(pool);
    const firstAt="2026-10-20T02:00:00.000Z";
    const revokedAt="2026-10-20T02:30:00.000Z";
    const author=buildEntityRef({kind:"author",canonicalId:"x:123",firstSeenAt:firstAt,lastSeenAt:firstAt});
    const entity=buildEntityRef({kind:"token",canonicalId:id,firstSeenAt:firstAt,lastSeenAt:firstAt});
    const evidence=buildEvidenceRef({sourceKind:"x_tweet",tweetId:"1024",
      occurredAt:occurred,observedAt:firstAt});
    const registry={
      sourceSystem:"x",eventKind:"tweet_observed",eventKey:"x:1024:test",
      schemaVersion:"v1",entityRefs:[author,entity],evidenceRef:evidence,
    };
    await ingestRegistryEvent(pool,registry);
    await ingestTimelineEvent(pool,"x","tweet_observed",buildTimelineEvent({
      eventKey:registry.eventKey,kind:"tweet_published",
      occurredAt:occurred,observedAt:firstAt,entityRefs:[author,entity],
      evidenceRef:evidence,payload:{text:"SECRET sensitive X payload"},
    }));
    const source=buildEntityRef({kind:"source",
      canonicalId:formatSourceId("tg","-100123"),
      firstSeenAt:firstAt,lastSeenAt:firstAt});
    const tgEvidence=(observedAt)=>buildEvidenceRef({
      sourceKind:"tg_message",sourceAccountId:"-100123",messageId:"42",
      occurredAt:occurred,observedAt,parserVersion:"tg-mint-verifier-v1",
    });
    const verified=buildVerifiedTokenLinkEvent({
      sourceSystem:"tg",sourceEntity:source,evidenceRef:tgEvidence(firstAt),
      mint,matchedLiteralMint:mint,sourceRevisionSha256:"a".repeat(64),
      mintVerification:{chainId:"solana-mainnet",method:"spl_mint_account",
        provider:"alchemy-solana-rpc",
        tokenProgram:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        checkedAt:firstAt},
    });
    const invalidated=buildTokenLinksInvalidatedEvent({
      sourceSystem:"tg",sourceEntity:source,evidenceRef:tgEvidence(revokedAt),
      reason:"edited",sourceRevisionSha256:"b".repeat(64),
    });
    for(const event of [verified,invalidated]){
      await ingestRegistryEvent(pool,event.payload.registryEvent);
      await ingestTokenLinkObservation(pool,event);
    }
    await withServer(pool,async origin=>{
      const earlier="occurredBefore="+encodeURIComponent(occurred)+"&knownAt="+encodeURIComponent("2026-10-20T02:10:00Z");
      const later="occurredBefore="+encodeURIComponent(occurred)+"&knownAt="+encodeURIComponent("2026-10-20T02:50:00Z");
      const tl=await fetch(origin+base+"/timeline?"+earlier,{headers:headers()});
      assert.equal(tl.status,200);
      const payload=await tl.json();
      assert.equal(payload.items.length,1);
      assert.ok(!JSON.stringify(payload).includes("SECRET"));
      const old=await fetch(origin+base+"/links?"+earlier,{headers:headers()});
      assert.equal(old.status,200);
      assert.equal((await old.json()).items.length,1);
      const latest=await fetch(origin+base+"/links?"+later,{headers:headers()});
      assert.equal(latest.status,200);
      assert.equal((await latest.json()).items.length,0);
    });
  }finally{
    if(pool)await pool.end();
    await admin.query("SET search_path TO public");
    await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
    await admin.end();
  }
});
