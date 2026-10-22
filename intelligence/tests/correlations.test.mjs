import test from "node:test";
import assert from "node:assert/strict";
import { formatTokenId } from "@claude-project/contracts";
import { calculateEventOutcomeCorrelations } from "../dist/index.js";

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
