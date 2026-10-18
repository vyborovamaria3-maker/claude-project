import test from "node:test";
import assert from "node:assert/strict";
import {formatTokenId} from "@claude-project/contracts";
import {FEATURES_V1,validateFeatureSnapshot,putFeatureSnapshot,queryFeaturesAsOf} from "../dist/index.js";

const fields={
  mentions_5m:2,mentions_15m:4,mentions_1h:8,
  unique_authors:3,unique_sources:2,velocity:1.5,acceleration:-0.5,
  sentiment_bullish_ratio:null,bot_ratio:null,smart_money_bought_at:null,
  liquidity_usd:null,volume_24h_usd:null,holder_concentration:null,
  decoder_coverage:"swap_only",history_coverage:"partial",data_confidence:0.45
};
const token=formatTokenId("solana","So11111111111111111111111111111111111111112");
const snap={
  canonicalTokenId:token,asOf:"2026-10-18T00:15:00Z",
  maxInputObservedAt:"2026-10-18T00:14:00Z",
  featureVersion:FEATURES_V1.version,features:fields
};

test("feature version allows explicit unknown observations rather than zero",()=>{
  const x=validateFeatureSnapshot(snap);
  assert.equal(x.features.bot_ratio,null);
  assert.equal(x.featureVersion,"features-v1");
  assert.equal(x.asOf,"2026-10-18T00:15:00.000Z");
});

test("future input, unknown field and invalid values fail closed",()=>{
  assert.throws(()=>validateFeatureSnapshot({
    ...snap,maxInputObservedAt:"2026-10-18T00:16:00Z"
  }),/Future-observed/);
  assert.throws(()=>validateFeatureSnapshot({
    ...snap,features:{...fields,bot_ratio:1.2}
  }),/bot_ratio/);
  assert.throws(()=>validateFeatureSnapshot({
    ...snap,features:{...fields,mentions_5m:-1}
  }),/mentions_5m/);
  assert.throws(()=>validateFeatureSnapshot({
    ...snap,features:{...fields,forecast_return:10000}
  }),/Unknown feature/);
  assert.throws(()=>validateFeatureSnapshot({
    ...snap,features:{...fields,liquidity_usd:0/0}
  }),/liquidity_usd/);
});

test("feature writes and reads preserve version, time cutoffs",async()=>{
  const calls=[];
  const tx={query:async(sql,params)=>{calls.push({sql,params});
    return{rows:sql.includes("RETURNING canonical_token_id")?[{canonical_token_id:token}]:[]};
  }};
  assert.equal(await putFeatureSnapshot(tx,snap),true);
  assert.equal(calls[0].params[3],FEATURES_V1.version);
  await queryFeaturesAsOf(tx,token,"2026-10-18T00:15:00Z");
  assert.match(calls[1].sql,/max_input_observed_at <= \$3/);
});
