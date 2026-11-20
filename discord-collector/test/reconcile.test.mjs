import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {scanRecentGap} from "../src/reconcile.mjs";
import {RestScheduler} from "../src/rest-scheduler.mjs";

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
test("each recovery page is scheduled separately so higher-priority work can interleave",async()=>{
  const channel=fakeChannel();
  const scheduler=new RestScheduler();
  const order=[];
  let preflight;
  let pageNumber=0;
  const fetchPage=options=>scheduler.run(async()=>{
    pageNumber++;
    order.push("page-"+pageNumber);
    const result=await channel.messages.fetch(options);
    if(pageNumber===1){
      preflight=scheduler.run(()=>{order.push("preflight")},{priority:0});
    }
    return result;
  },{priority:1,label:"gap-recovery-page"});
  const result=await scanRecentGap({
    channel,fetchPage,baselineMessageId:ids[239],maxPages:5,onMessage:async()=>{},
  });
  await preflight;
  assert.equal(result.status,"bounded_recovery");
  assert.deepEqual(order.slice(0,3),["page-1","preflight","page-2"]);
  assert.equal(pageNumber,3);
});

test("collector wires every recovery page through the priority REST scheduler",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  assert.match(source,/fetchPage:options=>scheduleRest\(\(\)=>channel\.messages\.fetch\(options\),\s*\{priority:1,label:"gap-recovery-page"\}\)/);
  assert.doesNotMatch(source,/scheduleRest\(async\(\)=>\{[\s\S]{0,300}scanRecentGap\(/);
});

test("recovery stops at the next safe boundary when authorization is revoked",async()=>{
  const channel=fakeChannel();
  let authorized=true;
  const delivered=[];
  const result=await scanRecentGap({
    channel,baselineMessageId:ids[239],maxPages:5,
    shouldContinue:()=>authorized,
    onMessage:async message=>{
      delivered.push(message.id);
      authorized=false;
    },
  });
  assert.equal(result.status,"gap_unresolved");
  assert.equal(result.pagesScanned,1);
  assert.equal(result.messagesProcessed,1);
  assert.equal(delivered.length,1);
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

test("history writes retry under a renewed active lease before advancing the backfill cursor",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  assert.match(source,/async function record\(message,kind,authorizationRetry=0\)/);
  assert.match(source,/\["not-authorized","authorization-expired"\]\.includes\(result\.status\)[\s\S]*isEventCurrentlyAuthorized\(allowed,observation\)[\s\S]*authorization_changed_during_source_write/);
});
