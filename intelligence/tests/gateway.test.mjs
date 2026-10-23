import test from "node:test";
import assert from "node:assert/strict";
import {createPotapoffGateway} from "../api/gateway.mjs";

const viewer="a".repeat(48),analyst="b".repeat(48),internal="c".repeat(48);
const token="solana:So11111111111111111111111111111111111111112";
const summary="/api/intelligence/v1/tokens/"+encodeURIComponent(token)+"/summary?asOf=2026-10-22T12%3A00%3A00Z";
const backtest="/api/intelligence/v1/backtest?asOf=2026-10-22T12%3A00%3A00Z";
async function fixture(t,audit={async query(){return {rows:[]}}}){
  const audits=[];const upstream=[];
  const db={async query(sql,params){audits.push({sql,params});return audit.query(sql,params)}};
  const server=createPotapoffGateway({clients:[
    {id:"viewer-role",role:"viewer",token:viewer},
    {id:"analyst-role",role:"analyst",token:analyst},
  ],internalApiToken:internal,auditDb:db,now:()=>new Date("2026-10-23T00:00:00Z"),
  fetchImpl:async(uri,init)=>{
    upstream.push({uri,init});
    assert.match(uri,/^http:\/\/127\.0\.0\.1:3182\//);
    assert.equal(init.headers.Authorization,"Bearer "+internal);
    return new Response(JSON.stringify({success:true}),{
      status:200,headers:{"content-type":"application/json; charset=utf-8"},
    });
  }});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {base:"http://127.0.0.1:"+server.address().port,audits,upstream};
}
test("POTAPoff gateway emits 401, 403, 200 and redacted audit logs",async t=>{
  const f=await fixture(t);
  let result=await fetch(f.base+summary);
  assert.equal(result.status,401);
  result=await fetch(f.base+backtest,{headers:{Authorization:"Bearer "+viewer}});
  assert.equal(result.status,403);
  result=await fetch(f.base+summary,{headers:{Authorization:"Bearer "+viewer}});
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{success:true});
  assert.equal(f.upstream.length,1);
  assert.equal(f.audits.length,3);
  assert.deepEqual(f.audits.map(x=>x.params[4]),[false,false,true]);
  assert.equal(f.audits[1].params[2],"viewer");
  assert.equal(JSON.stringify(f.audits).includes(viewer),false);
  assert.equal(JSON.stringify(f.audits).includes(internal),false);
});
test("gateway refuses access if security audit cannot be persisted",async t=>{
  const f=await fixture(t,{async query(){throw new Error("connection credentials: secret")}});
  const response=await fetch(f.base+summary,{headers:{Authorization:"Bearer "+analyst}});
  assert.equal(response.status,503);
  assert.equal(f.upstream.length,0);
  assert.doesNotMatch(JSON.stringify(await response.json()),/credentials|secret/);
});
