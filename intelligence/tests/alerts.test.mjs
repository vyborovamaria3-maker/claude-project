import test from "node:test";
import assert from "node:assert/strict";
import { formatTokenId } from "@claude-project/contracts";
import { evaluateCrossPlatformAlerts, formatTelegramAlert, persistAlertCandidates } from "../dist/index.js";

const token=formatTokenId("solana","So11111111111111111111111111111111111111112");
const base={
  canonicalTokenId:token,asOf:"2026-10-22T12:00:00Z",triggeredAt:"2026-10-22T12:00:01Z",
  maxInputObservedAt:"2026-10-22T11:59:00Z",scoreVersion:"cross-platform-heuristics-v2",
  evidenceRefs:["tg:message:1","x:tweet:2"],
};

test("alert rules detect multi-source anomalies with evidence",()=>{
  const alerts=evaluateCrossPlatformAlerts({
    ...base,tgMentions5m:75,xMentions5m:60,chainVolume1hUsd:1000,chainVolumeBaseline1hUsd:50,
    tgCopypastaRatio:0.9,xBotRatio:0.8,riskScore:0.85,correlationLift:2.4,correlationPValue:0.01,
    correlationExposedCount:20,correlationControlCount:20,correlationValidation:"out_of_sample",
  });
  assert.deepEqual(alerts.map((alert)=>alert.alertType),[
    "tg_mentions_spike","x_mentions_spike","chain_volume_anomaly","coordinated_copypasta",
    "high_bot_activity","rug_risk","correlation_candidate",
  ]);
  assert.equal(alerts.find((alert)=>alert.alertType==="rug_risk")?.severity,"critical");
  assert.ok(formatTelegramAlert(alerts[0]).includes(token));
});

test("candidate correlation alerts require adequate samples and stay exploratory",()=>{
  const candidate={...base,correlationLift:4,correlationPValue:0.001};
  assert.deepEqual(evaluateCrossPlatformAlerts(candidate),[]);
  assert.deepEqual(evaluateCrossPlatformAlerts({...candidate,correlationExposedCount:4,correlationControlCount:4,
    correlationValidation:"out_of_sample"}),[]);
  assert.deepEqual(evaluateCrossPlatformAlerts({...candidate,correlationExposedCount:10,correlationControlCount:10,
    correlationValidation:"out_of_sample"}).map(a=>a.alertType),["correlation_candidate"]);
});
test("forced validated correlation cannot be inserted based on a generic score-version certificate",async()=>{
  const candidates=evaluateCrossPlatformAlerts({...base,correlationLift:3,correlationPValue:0.002,
    correlationExposedCount:30,correlationControlCount:30,correlationValidation:"out_of_sample"})
    .map(candidate=>({...candidate,alertType:"validated_correlation"}));
  let inserts=0,checked=0;
  const db={async query(sql){
    if(sql.includes("signal_validation_registry")){checked++;return {rows:[]};}
    if(sql.includes("INSERT INTO token_alerts"))inserts++;
    return {rows:[]};
  }};
  await assert.rejects(persistAlertCandidates(db,candidates),/validated_correlation_scoped_evidence_required/);
  assert.equal(checked,0);assert.equal(inserts,0);
});

test("persistence suppresses any active incident regardless of age",async()=>{
  const candidates=evaluateCrossPlatformAlerts({...base,riskScore:0.9});
  let insertCalls=0;
  const tx={async query(sql){
    if(sql.includes("SELECT alert_id FROM token_alerts")){
      assert.doesNotMatch(sql,/INTERVAL '5 minutes'/);
      return {rows:[{alert_id:1}]};
    }
    if(sql.includes("INSERT INTO token_alerts")){insertCalls++;return {rows:[{alert_id:2}]};}
    return {rows:[]};
  }};
  assert.deepEqual(await persistAlertCandidates(tx,candidates),[]);
  assert.equal(insertCalls,0);
});

test("no evidence means no alert, and future-observed inputs are rejected",()=>{
  assert.deepEqual(evaluateCrossPlatformAlerts({...base,evidenceRefs:[],riskScore:0.9}),[]);
  assert.throws(()=>evaluateCrossPlatformAlerts({
    ...base,maxInputObservedAt:"2026-10-22T12:00:02Z",riskScore:0.9,
  }),/observed after as_of/);
  assert.throws(()=>evaluateCrossPlatformAlerts({...base,tgCopypastaRatio:1.1}),/Invalid alert ratio/);
});

test("candidate correlations remain exploratory with or without caller OOS claim",()=>{
  const alerts=evaluateCrossPlatformAlerts({...base,correlationLift:2.5,
    correlationPValue:0.001,correlationExposedCount:20,correlationControlCount:20,
    correlationValidation:"out_of_sample"});
  assert.equal(alerts.length,1);
  assert.equal(alerts[0].alertType,"correlation_candidate");
  const withoutClaim=evaluateCrossPlatformAlerts({...base,correlationLift:2.5,
    correlationPValue:0.001,correlationExposedCount:20,correlationControlCount:20});
  assert.equal(withoutClaim[0]?.alertType,"correlation_candidate");
});
