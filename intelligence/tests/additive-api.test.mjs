import test from "node:test";
import assert from "node:assert/strict";
import {createIntelligenceApi,checkApiReadiness,checkCrossPlatformReadiness} from "../api/server.mjs";
const token="a".repeat(40),aiToken="b".repeat(40);
const mint="solana:So11111111111111111111111111111111111111112";
const pool={query:async()=>{throw new Error("must not query disabled extension")}};
async function withApi(config,fn){
 const server=createIntelligenceApi({token,pool,...config});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{await fn("http://127.0.0.1:"+server.address().port)}
 finally{await new Promise(resolve=>server.close(resolve))}
}
test("new routes default off while original migrations stay sufficient",async()=>{
 await assert.doesNotReject(checkApiReadiness({query:async()=>({rows:[{inbox:true,timeline:true,entities:true,links:true,swap_revisions:true}]})}));
 await assert.rejects(checkCrossPlatformReadiness({query:async()=>({rows:[{ready:false}]})}),/cross_platform_migrations_required/);
 await withApi({},async origin=>{
  const response=await fetch(origin+"/api/intelligence/v1/tokens/"+mint+"/summary?asOf=2026-01-01T00:00:00.000Z",{headers:{Authorization:"Bearer "+token}});
  assert.equal(response.status,404);
 });
});
test("aggregate AI bearer cannot trigger on-demand provider work",async()=>{
 let calls=0;
 await withApi({aiEnabled:true,aiToken,analyzeToken:async()=>{calls++;return {ok:true}}},async origin=>{
  const response=await fetch(origin+"/api/intelligence/v1/tokens/"+mint+"/analyze",{method:"POST",headers:{Authorization:"Bearer "+aiToken}});
  assert.equal(response.status,404);assert.equal(calls,0);
 });
});
