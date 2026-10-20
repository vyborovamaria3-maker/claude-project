import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {
  SafeProxyError,parseClientTokenQuery,validateProxyConfiguration,
  projectVerifiedResponse,fetchTokenIntelligence,
} from "../lib/token-intelligence/proxy-core.mjs";

const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const mint="So11111111111111111111111111111111111111112";
const tokenId="solana:"+mint;
const knownAt="2026-10-20T03:00:00.000Z";
const occurredBefore="2026-10-19T22:00:00.000Z";
const query={knownAt,occurredBefore,limit:5};
const secret="secret-server-only-token-"+
  "x".repeat(32);
const env={
  POTAPOFF_TOKEN_INTELLIGENCE_ENABLED:"true",
  INTELLIGENCE_API_TOKEN:secret.replaceAll("-","_"),
  INTELLIGENCE_API_PORT:"3182",
};
function fixture(resource="links"){
  return {
    schemaVersion:"token-intelligence-v1",tokenId,knownAt,occurredBefore,
    historicalCompleteness:"unknown",truncated:false,
    items:resource==="links"?[{
      source:"tg",evidenceId:"tg:message:-10012345:42",
      occurredAt:occurredBefore,observedAt:"2026-10-20T02:00:00.000Z",
      verification:"source_verified_spl_mint_account",
      secret:"NEVER-EXPORT",details:{secret:"NEVER-EXPORT"},
    }]:[{
      source:"x",evidenceId:"x:tweet:100",kind:"tweet_published",
      occurredAt:occurredBefore,observedAt:"2026-10-20T02:00:00.000Z",
      payload:{text:"NEVER-EXPORT"},eventKey:"NEVER-EXPORT",
    }],
    session:"NEVER-EXPORT",
  };
}
test("query parameters must be exact UTC, bounded and not future-known",()=>{
  const parsed=parseClientTokenQuery(new URLSearchParams(query).toString(),
    new Date("2026-10-20T03:05:00Z"));
  assert.deepEqual(parsed,query);
  const withFraction=parseClientTokenQuery(
    "knownAt=2026-10-20T03%3A00%3A00Z&"+
    "occurredBefore=2026-10-19T22%3A00%3A00.0Z",
    new Date("2026-10-20T03:05:00Z"),
  );
  assert.equal(withFraction.knownAt,knownAt);
  for(const bad of [
    "knownAt="+knownAt,
    "knownAt="+knownAt+"&occurredBefore="+occurredBefore+"&limit=1000",
    "knownAt="+knownAt+"&occurredBefore="+occurredBefore+"&unknown=1",
    "knownAt="+knownAt+"&occurredBefore="+occurredBefore+"&limit=5&limit=2",
    "knownAt=2026-10-20T03:00:00+03:00&occurredBefore="+occurredBefore,
    "knownAt=2026-10-20T03:00:00.000Z&occurredBefore=2026-10-20T03:01:00.000Z",
    "knownAt=2026-10-20T03:10:00.000Z&occurredBefore="+occurredBefore,
  ])assert.throws(()=>parseClientTokenQuery(bad,
    new Date("2026-10-20T03:05:00Z")),SafeProxyError);
});
test("disabled feature or missing secret fails closed; port never becomes external URL",()=>{
  assert.throws(()=>validateProxyConfiguration({}),SafeProxyError);
  assert.throws(()=>validateProxyConfiguration({
    POTAPOFF_TOKEN_INTELLIGENCE_ENABLED:"true",
    INTELLIGENCE_API_TOKEN:"short",
  }),SafeProxyError);
  assert.throws(()=>validateProxyConfiguration({...env,INTELLIGENCE_API_PORT:"https://evil.example"}),
    SafeProxyError);
  assert.throws(()=>validateProxyConfiguration({...env,INTELLIGENCE_API_PORT:"70000"}),
    SafeProxyError);
  assert.equal(validateProxyConfiguration(env).port,3182);
});
test("proxy strips sensitive upstream fields from verified Timeline and links",()=>{
  for(const resource of ["links","timeline"]){
    const response=projectVerifiedResponse(fixture(resource),resource,tokenId,query);
    assert.equal(response.schemaVersion,"potapoff-token-intelligence-v1");
    assert.equal(response.historicalCompleteness,"unknown");
    assert.equal(response.items.length,1);
    assert.ok(!JSON.stringify(response).includes("NEVER-EXPORT"));
    assert.equal(Object.hasOwn(response,"session"),false);
    assert.equal(response.items[0].evidenceId,
      resource==="links"?"tg:message:-10012345:42":"x:tweet:100");
  }
  for(const bad of [
    {...fixture(),tokenId:"solana:forged"},
    {...fixture(),knownAt:"2025-01-01T00:00:00Z"},
    {...fixture(),historicalCompleteness:"complete"},
    {...fixture(),items:[{...fixture().items[0],verification:"unverified"}]},
    {...fixture(),items:Array(6).fill(fixture().items[0])},
  ])assert.throws(()=>projectVerifiedResponse(bad,"links",tokenId,query),SafeProxyError);
});
test("fetch is loopback-only, supplies secret only to local upstream and never projects it",async()=>{
  let requests=0;
  const result=await fetchTokenIntelligence(mint,"links",query,{
    env,
    fetchImpl:async(url,options)=>{
      requests++;
      assert.equal(new URL(url).hostname,"127.0.0.1");
      assert.equal(new URL(url).port,"3182");
      assert.equal(new URL(url).pathname,
        "/api/intelligence/v1/tokens/solana%3A"+mint+"/links");
      assert.equal(options.headers.Authorization,"Bearer "+env.INTELLIGENCE_API_TOKEN);
      assert.equal(options.redirect,"error");
      assert.equal(options.cache,"no-store");
      return new Response(JSON.stringify(fixture()),{status:200});
    },
  });
  assert.equal(requests,1);
  assert.equal(result.items[0].evidenceId,"tg:message:-10012345:42");
  assert.ok(!JSON.stringify(result).includes(env.INTELLIGENCE_API_TOKEN));
  assert.ok(!JSON.stringify(result).includes("NEVER-EXPORT"));
});
test("upstream errors, oversized payload, invalid JSON and raw network failures are sanitized",async()=>{
  for(const fake of [
    async()=>new Response(JSON.stringify({error:"SECRET-DSN"}),{status:503}),
    async()=>new Response(JSON.stringify(fixture()).repeat(2000),{status:200}),
    async()=>new Response("NOT JSON",{status:200}),
    async()=>{throw new Error("Bearer SECRET-DSN")},
  ]){
    await assert.rejects(
      fetchTokenIntelligence(mint,"links",query,{env,fetchImpl:fake}),
      e=>e instanceof SafeProxyError&&!e.message.includes("SECRET"),
    );
  }
});
test("Next.js route authorizes POTAPoff users, never sends secret to page",()=>{
  const route=readFileSync(join(root,
    "app/api/intelligence/token/[mint]/[resource]/route.ts"),"utf8");
  const page=readFileSync(join(root,"app/intelligence/token/page.tsx"),"utf8");
  const hub=readFileSync(join(root,"app/intelligence/page.tsx"),"utf8");
  assert.ok(route.includes("await requireProdAuth(request)"),
    "must reuse existing POTAPoff subscription auth");
  assert.ok(route.indexOf("await requireProdAuth(request)")<
    route.indexOf("fetchTokenIntelligence(mint,resource,query)"));
  assert.ok(route.includes("new PublicKey(mint).toBase58()!==mint"));
  assert.ok(route.includes("checkRateLimit("));
  assert.ok(route.includes('POTAPOFF_TOKEN_INTELLIGENCE_ENABLED'));
  assert.ok(page.includes("new URLSearchParams"));
  assert.ok(page.includes('credentials:"same-origin"'));
  assert.ok(hub.includes('href="/intelligence/token"'));
  for(const forbidden of [
    "INTELLIGENCE_API_TOKEN","INTELLIGENCE_DATABASE_URL",
    "http://127.0.0.1:","NEXT_PUBLIC_INTELLIGENCE_API",
  ])assert.ok(!page.includes(forbidden),
    "browser must not contain upstream secrets or direct database access");
});
