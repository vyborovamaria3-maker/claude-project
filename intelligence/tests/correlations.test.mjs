import test from "node:test";
import assert from "node:assert/strict";
import { formatTokenId } from "@claude-project/contracts";
import { calculateEventOutcomeCorrelations, persistEventOutcomeCorrelations } from "../dist/index.js";

const token=formatTokenId("solana","So11111111111111111111111111111111111111112");
function sample(index,exposed,outcome) {
  const eventAt=new Date(Date.parse("2026-10-01T00:00:00Z")+index*60*60_000);
  return {
    canonicalTokenId:token,eventKind:"tg_first_mention",eventAt,
    outcomeKind:"price_2x_24h",outcomeAt:new Date(eventAt.getTime()+24*60*60_000),
    exposed,outcome,maxInputObservedAt:new Date(eventAt.getTime()-60_000),
    outcomeObservedAt:new Date(eventAt.getTime()+25*60*60_000),
  };
}

test("correlation calculates lift, confidence interval and significance against unexposed windows",()=>{
  const samples=[];
  for(let i=0;i<10;i++)samples.push(sample(i,true,i<6));
  for(let i=10;i<30;i++)samples.push(sample(i,false,i<14));
  const [result]=calculateEventOutcomeCorrelations(samples,"2026-10-04T12:00:00Z");
  assert.ok(result);
  assert.equal(result.sampleSize,30);
  assert.equal(result.exposedRate,0.6);
  assert.equal(result.controlRate,0.2);
  assert.ok(Math.abs(result.lift-3)<1e-12);
  assert.ok(result.ciLow<result.lift&&result.ciHigh>result.lift);
  assert.ok(result.pValue<0.05);
});

test("correlation groups are isolated by token",()=>{
  const tokenB=formatTokenId("solana","EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const samples=[sample(1,true,true),sample(2,true,true),sample(3,false,false),sample(4,false,false),
    {...sample(5,true,false),canonicalTokenId:tokenB},{...sample(6,false,true),canonicalTokenId:tokenB}];
  const results=calculateEventOutcomeCorrelations(samples,"2026-10-04T12:00:00Z");
  assert.equal(results.length,2);
  assert.ok(results.every((result)=>result.samples.every((item)=>item.canonicalTokenId===result.samples[0]?.canonicalTokenId)));
});

test("persistence stores one aggregate row per token/event/outcome group",async()=>{
  const samples=[sample(1,true,true),sample(2,true,false),sample(3,false,false),sample(4,false,false)];
  const writes=[];
  const tx={async query(sql,params){if(sql.includes("INSERT INTO token_correlations")){writes.push({sql,params});return {rows:[{correlation_id:writes.length}]};}return {rows:[]};}};
  const count=await persistEventOutcomeCorrelations(tx,samples,{evaluatedAt:"2026-10-04T12:00:00Z",dataCutoffAt:"2026-10-04T12:00:00Z"});
  assert.equal(count,1); assert.equal(writes.length,1);
  assert.match(writes[0].sql,/VALUES \(\$1,\$2,\$3,\$4,NULL/);
  const baseline=JSON.parse(writes[0].params[8]);
  assert.equal(baseline.eventWindowStart,"2026-10-01T01:00:00.000Z");
  assert.equal(baseline.eventWindowEnd,"2026-10-01T04:00:00.000Z");
});

test("correlation rejects look-ahead and never fabricates lift when control rate is zero",()=>{
  assert.throws(()=>calculateEventOutcomeCorrelations([{
    ...sample(1,true,true),maxInputObservedAt:"2026-10-01T02:00:00Z",
  }],"2026-10-03T12:00:00Z"),/Look-ahead/);
  const result=calculateEventOutcomeCorrelations([
    sample(1,true,true),sample(2,true,false),sample(3,false,false),sample(4,false,false),
  ],"2026-10-03T12:00:00Z")[0];
  assert.equal(result?.lift,null);
  assert.equal(result?.controlRate,0);
});
