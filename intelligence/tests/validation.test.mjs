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
test("training outcomes observed after holdout starts are rejected",()=>{
  const rows=cohort();
  rows[70]={...rows[70],outcomeObservedAt:"2026-10-10T06:00:00.000Z"};
  assert.throws(()=>evaluateTemporalHoldout(rows),/holdout_train_outcomes_cross_split_boundary/);
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
  let horizon=24,cutoff="2026-10-20T00:00:00Z",writes=0;
  const db={async query(sql){
    if(sql.includes("INSERT INTO signal_validation_registry")){writes++;return {rows:[]};}
    if(sql.includes("FROM backtest_runs"))return {rows:[{
      run_id:"00000000-0000-4000-8000-000000000001",status:"completed",
      signal_name:"attention_score",outcome_kind:"price_2x_24h",threshold:"0.7",baseline_kind:"market_average",
      feature_version:"cross-platform-heuristics-v2",horizon_hours:horizon,model_id:null,
      metrics:{sampleSize:120,outcomeCoverage:{eligibleCount:120,labeledCount:120,
        completedHorizonCount:120,missingOutcomeCount:0,incompleteHorizonCount:0,ambiguousOutcomeCount:0}},data_cutoff_at:cutoff,
      completed_at:"2026-10-21T00:00:00Z",
    }]};
    if(sql.includes("FROM backtest_results r")&&sql.includes("token_daily_cross_platform"))
      return {rows:[{invalid:0}]};
    if(sql.includes("FROM backtest_results"))return {rows:rows.map(r=>({
      canonical_token_id:r.canonicalTokenId,signal_at:r.signalAt,score:r.score,
      selected:r.selected,outcome_label:r.outcome,outcome_at:r.outcomeAt,
      outcome_observed_at:r.outcomeObservedAt,
    }))};
    if(sql.includes("FROM signal_policy_preregistrations"))return {rows:[{
      policy_id:"00000000-0000-4000-8000-000000000002",
      registered_at:"2026-09-30T00:00:00Z",
    }]};
    throw new Error("unexpected SQL");
  }};
  const args={runId:"00000000-0000-4000-8000-000000000001",
    signalVersion:"cross-platform-heuristics-v2",codeRevision:"a".repeat(40)};
  const a=await certifyTemporalHoldout(db,args);
  const b=await certifyTemporalHoldout(db,args);
  assert.equal(a.passed,true);
  assert.equal(a.reproducibilityHash,b.reproducibilityHash);
  assert.match(a.reproducibilityHash,/^[a-f0-9]{64}$/);
  const original=rows[0];
  rows[0]={...original,outcomeAt:"2026-10-03T12:00:00Z",outcomeObservedAt:"2026-10-03T13:00:00Z"};
  await assert.rejects(certifyTemporalHoldout(db,args),/validation_outside_completed_horizon/);
  rows[0]=original;
  cutoff="2026-10-12T15:00:00Z"; // All labels exist, but the final 24h horizon is unfinished.
  await assert.rejects(certifyTemporalHoldout(db,args),/validation_outside_completed_horizon/);
  cutoff="2026-10-20T00:00:00Z";
  for(const invalid of [0,1.5,721,null]){
    horizon=invalid;
    await assert.rejects(certifyTemporalHoldout(db,args),/validation_invalid_horizon/);
  }
  assert.equal(writes,2,"invalid runs must never publish a certificate");
});

test("missing outcomes cannot be silently counted as false",async()=>{
  const db={async query(sql){
    if(sql.includes("FROM backtest_runs"))return {rows:[{
      status:"completed",signal_name:"attention_score",outcome_kind:"price_2x_24h",threshold:"0.7",
      baseline_kind:"market_average",feature_version:"cross-platform-heuristics-v2",
      horizon_hours:24,metrics:{sampleSize:1,outcomeCoverage:{eligibleCount:1,labeledCount:1,
        completedHorizonCount:1,missingOutcomeCount:0,incompleteHorizonCount:0,ambiguousOutcomeCount:0}},data_cutoff_at:"2026-10-20T00:00:00Z",
      completed_at:"2026-10-21T00:00:00Z",
    }]};
    if(sql.includes("FROM backtest_results"))return {rows:[{
      canonical_token_id:"a",signal_at:"2026-10-01T00:00:00Z",
      score:"0.9",selected:true,outcome_label:null,
      outcome_at:"2026-10-01T01:00:00Z",
      outcome_observed_at:"2026-10-01T02:00:00Z",
    }]};
    throw new Error("unexpected query");
  }};
  await assert.rejects(certifyTemporalHoldout(db,{
    runId:"00000000-0000-4000-8000-000000000001",
    signalVersion:"cross-platform-heuristics-v2",codeRevision:"a".repeat(40),
  }),/validation_requires_explicit_boolean_outcomes/);
});

test("holdout certification fails if persisted rows have no source proof",async()=>{
  const rows=cohort();
  const db={async query(sql){
    if(sql.includes("FROM backtest_runs"))return {rows:[{
      status:"completed",signal_name:"attention_score",outcome_kind:"price_2x_24h",
      threshold:"0.7",baseline_kind:"market_average",feature_version:"cross-platform-heuristics-v2",
      horizon_hours:24,metrics:{sampleSize:rows.length,outcomeCoverage:{
        eligibleCount:rows.length,labeledCount:rows.length,completedHorizonCount:rows.length,
        missingOutcomeCount:0,incompleteHorizonCount:0,ambiguousOutcomeCount:0,
      }},data_cutoff_at:"2026-10-20T00:00:00Z",completed_at:"2026-10-21T00:00:00Z",
    }]};
    if(sql.includes("FROM backtest_results r")&&sql.includes("token_daily_cross_platform"))
      return {rows:[{invalid:1}]};
    if(sql.includes("FROM backtest_results"))return {rows:rows.map(r=>({
      canonical_token_id:r.canonicalTokenId,signal_at:r.signalAt,score:r.score,selected:r.selected,
      outcome_label:r.outcome,outcome_at:r.outcomeAt,outcome_observed_at:r.outcomeObservedAt,
    }))};
    throw new Error("unexpected SQL");
  }};
  await assert.rejects(certifyTemporalHoldout(db,{
    runId:"00000000-0000-4000-8000-000000000001",signalVersion:"cross-platform-heuristics-v2",
    codeRevision:"a".repeat(40),
  }),/validation_requires_verified_source_and_outcome_provenance/);
});
