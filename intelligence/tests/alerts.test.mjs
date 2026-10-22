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
  });
  assert.deepEqual(alerts.map((alert)=>alert.alertType),[
    "tg_mentions_spike","x_mentions_spike","chain_volume_anomaly","coordinated_copypasta",
    "high_bot_activity","rug_risk","validated_correlation",
  ]);
  assert.equal(alerts.find((alert)=>alert.alertType==="rug_risk")?.severity,"critical");
  assert.ok(formatTelegramAlert(alerts[0]).includes(token));
});

test("persistence suppresses repeated active alert types inside the five-minute cooldown",async()=>{
  const candidates=evaluateCrossPlatformAlerts({...base,riskScore:0.9});
  let insertCalls=0;
  const tx={async query(sql){
    if(sql.includes("SELECT alert_id FROM token_alerts"))return {rows:[{alert_id:1}]};
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
