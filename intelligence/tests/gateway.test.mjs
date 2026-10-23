import test from "node:test";
import assert from "node:assert/strict";
import {createPotapoffGateway} from "../api/gateway.mjs";

const viewer="a".repeat(48),analyst="b".repeat(48),internal="c".repeat(48);
const token="solana:So11111111111111111111111111111111111111112";
const summary="/api/intelligence/v1/tokens/"+encodeURIComponent(token)+"/summary?asOf=2026-10-22T12%3A00%3A00Z";
const backtest="/api/intelligence/v1/backtest?signal=attention_score";
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
test("gateway rejects upstream redirects and streams with oversized bodies",async t=>{
  const audit={async query(){return {rows:[]}}};
  const client="a".repeat(48);
  const endpoint="/api/intelligence/v1/backtest?signal=attention_score";
  const cases=[
    async()=>new Response(null,{status:302,headers:{location:"https://example.org/leak"}}),
    async()=>new Response(new ReadableStream({start(controller){
      controller.enqueue(new Uint8Array(1024*1024+1));controller.close();
    }}),{status:200,headers:{"content-type":"application/json"}}),
    async()=>new Response(JSON.stringify({detail:"private-database-secret"}),{
      status:500,headers:{"content-type":"application/json"},
    }),
  ];
  let index=0;
  const server=createPotapoffGateway({clients:[{id:"analyst",role:"analyst",token:client}],
    internalApiToken:"c".repeat(48),auditDb:audit,
    now:()=>new Date("2026-10-23T00:00:00Z"),
    fetchImpl:async(uri,opts)=>{
      assert.equal(opts.redirect,"error");
      return cases[index++]();
    },
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base="http://127.0.0.1:"+server.address().port;
  for(let n=0;n<3;n++){
    const response=await fetch(base+endpoint,{headers:{Authorization:"Bearer "+client}});
    assert.equal(response.status,502);
    const body=await response.text();
    assert.doesNotMatch(body,/private-database-secret/);
  }
  assert.equal(index,3);
});
test("gateway refuses access if security audit cannot be persisted",async t=>{
  const f=await fixture(t,{async query(){throw new Error("connection credentials: secret")}});
  const response=await fetch(f.base+summary,{headers:{Authorization:"Bearer "+analyst}});
  assert.equal(response.status,503);
  assert.equal(f.upstream.length,0);
  assert.doesNotMatch(JSON.stringify(await response.json()),/credentials|secret/);
});

test("oversized request target is audited before any response",async t=>{
  const f=await fixture(t);
  const response=await fetch(f.base+summary+"&junk="+"z".repeat(2500),{
    headers:{Authorization:"Bearer "+analyst},
  });
  assert.equal(response.status,414);
  assert.equal(f.audits.length,1);
  assert.equal(f.audits[0].params[0].length,36);
  assert.equal(f.upstream.length,0);
});
