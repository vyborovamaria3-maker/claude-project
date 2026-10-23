import test from "node:test";
import assert from "node:assert/strict";
import {evaluateTemporalHoldout,certifyTemporalHoldout} from "../dist/index.js";

function sample(day,index,selected,outcome){
  const stamp=new Date(Date.UTC(2026,9,day,12)).toISOString();
  return {canonicalTokenId:"token-"+day+"-"+index,signalAt:stamp,score:selected?0.9:0.1,
    selected,outcome,outcomeAt:new Date(Date.parse(stamp)+3600000).toISOString(),
    outcomeObservedAt:new Date(Date.parse(stamp)+7200000).toISOString()};
}
function cohort(){
  const rows=[];
  for(let day=1;day<=12;day++)for(let i=0;i<10;i++)
    rows.push(sample(day,i,i<5,i<5?i<4:i===5));
  return rows;
}
test("chronological holdout is disjoint and statistically significant",()=>{
  const result=evaluateTemporalHoldout(cohort());
  assert.equal(result.trainCount+result.testCount,120);
  assert.ok(result.trainCount>=20&&result.testCount>=20);
  assert.equal(result.selectedRate,0.8);
  assert.equal(result.controlRate,0.2);
  assert.ok(result.pValue<0.05);
  assert.equal(result.passed,true);
});
test("repeated tokens are rejected as dependent samples",()=>{
  const rows=cohort();
  rows[100]={...rows[100],canonicalTokenId:rows[0].canonicalTokenId};
  assert.throws(()=>evaluateTemporalHoldout(rows),/dependent_observations/);
});
test("insufficient controls cannot validate",()=>{
  const rows=cohort().map(row=>row.signalAt.startsWith("2026-10-1")?
    {...row,score:0.99,selected:true}:row);
  assert.throws(()=>evaluateTemporalHoldout(rows),/control_groups_too_small/);
});
test("holdout certificate is deterministic and bound to run details",async()=>{
  const rows=cohort();
  const db={async query(sql){
    if(sql.includes("FROM backtest_runs"))return {rows:[{
      run_id:"00000000-0000-4000-8000-000000000001",status:"completed",
      signal_name:"attention_score",threshold:"0.7",baseline_kind:"market_average",
      feature_version:"cross-platform-heuristics-v2",horizon_hours:24,model_id:null,
      metrics:{sampleSize:120},data_cutoff_at:"2026-10-20T00:00:00Z",
      completed_at:"2026-10-21T00:00:00Z",
    }]};
    if(sql.includes("FROM backtest_results"))return {rows:rows.map(r=>({
      canonical_token_id:r.canonicalTokenId,signal_at:r.signalAt,score:r.score,
      selected:r.selected,outcome_label:r.outcome,outcome_at:r.outcomeAt,
      outcome_observed_at:r.outcomeObservedAt,
    }))};
    if(sql.includes("FROM signal_policy_preregistrations"))return {rows:[{
      policy_id:"00000000-0000-4000-8000-000000000002",
      registered_at:"2026-09-30T00:00:00Z",
    }]};
    if(sql.includes("INSERT INTO signal_validation_registry"))return {rows:[]};
    throw new Error("unexpected SQL");
  }};
  const args={runId:"00000000-0000-4000-8000-000000000001",
    signalVersion:"cross-platform-heuristics-v2",codeRevision:"a".repeat(40)};
  const a=await certifyTemporalHoldout(db,args);
  const b=await certifyTemporalHoldout(db,args);
  assert.equal(a.passed,true);
  assert.equal(a.reproducibilityHash,b.reproducibilityHash);
  assert.match(a.reproducibilityHash,/^[a-f0-9]{64}$/);
});
