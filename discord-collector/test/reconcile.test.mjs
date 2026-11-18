import test from "node:test";
import assert from "node:assert/strict";
import {scanRecentGap} from "../src/reconcile.mjs";

const root=1300000000000000000n;
const ids=Array.from({length:250},(_,i)=>String(root+BigInt(250-i)));
function fakeChannel(){
  const requests=[];
  return {
    requests,
    messages:{
      async fetch(args){
        requests.push({...args});
        const before=args.before?BigInt(args.before):null;
        const available=ids.filter(id=>before===null||BigInt(id)<before);
        const selected=available.slice(0,args.limit);
        return new Map(selected.map(id=>[id,{id}]));
      }
    }
  };
}
test("recover full bounded recent gap across multiple pages",async()=>{
  const channel=fakeChannel();
  const delivered=[];
  const r=await scanRecentGap({
    channel,baselineMessageId:ids[239],maxPages:5,
    onMessage: async m=>delivered.push(m.id)
  });
  assert.equal(r.status,"bounded_recovery");
  assert.equal(r.reachedBaseline,true);
  assert.equal(delivered.length,239);
  assert.equal(channel.requests.length,3);
  assert.equal(channel.requests[0].limit,100);
  assert.equal(channel.requests[1].before,ids[99]);
});
test("budget exhausted must never claim full recovery",async()=>{
  const channel=fakeChannel();
  const r=await scanRecentGap({
    channel,baselineMessageId:ids[249],maxPages:1,onMessage:async()=>{}
  });
  assert.equal(r.status,"gap_unresolved");
  assert.equal(r.pagesScanned,1);
});
test("first-time channel is explicitly unverified",async()=>{
  const channel=fakeChannel();
  const r=await scanRecentGap({
    channel,baselineMessageId:null,maxPages:1,onMessage:async()=>{}
  });
  assert.equal(r.status,"initial_unverified");
});
test("provider permission failure surfaces, no false success",async()=>{
  const channel={messages:{fetch:async()=>{throw new Error("403 Forbidden")}}};
  await assert.rejects(scanRecentGap({
    channel,baselineMessageId:null,maxPages:1,onMessage:async()=>{}
  }),/403/);
});
test("invalid recovery budgets rejected",async()=>{
  const channel=fakeChannel();
  await assert.rejects(scanRecentGap({
    channel,baselineMessageId:null,maxPages:0,onMessage:async()=>{}
  }),/budget/);
});
