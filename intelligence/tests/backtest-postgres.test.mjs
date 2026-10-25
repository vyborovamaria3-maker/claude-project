import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { selectBacktestObservations } from "../scripts/backtest.mjs";
import { refreshTokenDailyCrossPlatform, recordSourceCoverageWindow, runSignalBacktest, persistBacktestRun } from "../dist/index.js";

const url=process.env.INTELLIGENCE_TEST_DB_URL;
const token="solana:So11111111111111111111111111111111111111112";
async function isolated(fn) {
  const client=new pg.Client({connectionString:url});
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA backtest_regression");
    await client.query("SET LOCAL search_path TO backtest_regression");
    for(const file of ["001_entity_registry.sql","002_timeline.sql","003_feature_store.sql",
      "004_token_link_observations.sql","005_blockchain_swap_evidence_revisions.sql","006_cross_platform_analytics.sql","009_ai_analysis.sql"])
      await client.query(await readFile(new URL("../migrations/"+file,import.meta.url),"utf8"));
    await fn(client);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}
const args=(day)=>({signal:"attention_score",outcome:"price_2x_24h",horizonHours:1,from:day,to:day});
async function label(client,at,positive=true) {
  await client.query(`INSERT INTO token_outcomes
    (canonical_token_id,outcome_kind,outcome_at,observed_at,label,source_system,label_version,created_at)
    VALUES ($1,'price_2x_24h',$2,$2,$3,'derived','test',$2)`,[token,at,positive]);
}

test("real refresh is eligible only at its write time; horizons and labels start there",{skip:!url},async()=>{
  await isolated(async client=>{
    const now=Date.now(),day=new Date(now-86400000).toISOString().slice(0,10);
    const nextDay=new Date(Date.parse(day+"T00:00:00Z")+86400000).toISOString();
    for(const sourceSystem of ["tg","x","blockchain"])
      await recordSourceCoverageWindow(client,{sourceSystem,windowStart:day+"T00:00:00Z",
        windowEnd:nextDay,knownAt:nextDay,status:"complete"});
    await recordSourceCoverageWindow(client,{sourceSystem:"blockchain",windowStart:day+"T00:00:00Z",
      windowEnd:nextDay,knownAt:nextDay,status:"complete",details:{scope:"token_swap_evidence_revisions"}});
    const asOf=new Date().toISOString();
    await client.query("SELECT pg_sleep(0.02)");
    await refreshTokenDailyCrossPlatform(client,token,day,asOf);
    const {rows:[saved]}=await client.query("SELECT created_at,as_of FROM token_daily_cross_platform");
    assert.ok(saved.created_at>saved.as_of);
    const signalDay=saved.created_at.toISOString().slice(0,10);
    await label(client,new Date(Date.parse(asOf)+1)); // Occurred before computation finished.
    const outcomeAt=new Date(saved.created_at.getTime()+60_000);
    await label(client,outcomeAt,false);
    const selected=await selectBacktestObservations(client,args(signalDay),new Date(saved.created_at.getTime()+7200000));
    assert.equal(selected.rows.length,1);
    assert.equal(selected.rows[0].signal_at.toISOString(),saved.created_at.toISOString());
    assert.equal(selected.rows[0].outcome_at.toISOString(),outcomeAt.toISOString());
    assert.equal(selected.rows[0].outcome,false);
    assert.equal(Number(selected.rows[0].outcome_match_count),1);
    assert.equal(selected.rows[0].horizon_complete,true);
    // Conflicting labels from different versions in the same horizon must
    // make the cohort ambiguous rather than silently choosing a winner.
    await client.query(`INSERT INTO token_outcomes
      (canonical_token_id,outcome_kind,outcome_at,observed_at,label,source_system,label_version,created_at)
      VALUES ($1,'price_2x_24h',$2,$2,true,'derived','revised',$2)`,[token,outcomeAt]);
    const conflicting=await selectBacktestObservations(client,args(signalDay),
      new Date(saved.created_at.getTime()+7200000));
    assert.equal(Number(conflicting.rows[0].outcome_match_count),2);
    const early=await selectBacktestObservations(client,args(signalDay),saved.as_of);
    assert.equal(early.rows.length,0,"snapshot must not be backdated to its input cutoff");
    const immature=await selectBacktestObservations(client,args(signalDay),new Date(saved.created_at.getTime()+1800000));
    assert.equal(immature.rows[0].horizon_complete,false);
  });
});

test("range applies before daily selection and persistence uses the same signal date",{skip:!url},async()=>{
  await isolated(async client=>{
    // Historical fixtures: input day, input cutoff and write time are intentionally different.
    const base=Date.parse(new Date(Date.now()-7*86400000).toISOString().slice(0,10)+"T00:00:00Z");
    const iso=hours=>new Date(base+hours*3600000).toISOString();
    const day=iso(0).slice(0,10),priorDay=iso(-24).slice(0,10);
    const insert=async(sourceDay,asOf,createdAt,score)=>client.query(`INSERT INTO token_daily_cross_platform
      (canonical_token_id,day,as_of,max_input_observed_at,created_at,credibility_score,
       tg_copypasta_ratio,x_bot_ratio,score_version,score_reason,source_coverage,data_confidence,snapshot_sha256)
      VALUES ($1,$2,$3,$3,$4,$5,0,0,'test','{}','{"tg":"complete","x":"complete"}',1,$6)`,
      [token,sourceDay,asOf,createdAt,score,"a".repeat(64)]);
    await insert(day,iso(10),iso(12),0.2);
    await insert(day,iso(11),iso(24.25),0.9); // Later write must not displace the in-range snapshot.
    await label(client,iso(12.5));
    await label(client,iso(24.75),false);
    const query={...args(day),signal:"credibility_score"};
    const first=await selectBacktestObservations(client,query,iso(72));
    assert.equal(first.rows.length,1);
    assert.equal(first.rows[0].signal_at.toISOString(),iso(12));
    // Another source day written on the same signal day must not overweight this token.
    await insert(priorDay,iso(-1),iso(13),0.7);
    await label(client,iso(13.5),false);
    const selected=await selectBacktestObservations(client,query,iso(72));
    assert.equal(selected.rows.length,1);
    assert.equal(selected.rows[0].signal_at.toISOString(),iso(13));
    const rows=selected.rows.map(r=>({canonicalTokenId:r.canonical_token_id,signalAt:r.signal_at,
      maxInputObservedAt:r.max_input_observed_at,outcomeAt:r.outcome_at,
      outcomeObservedAt:r.outcome_observed_at,score:Number(r.score),outcome:r.outcome}));
    const run=runSignalBacktest(rows,{threshold:0.5});
    await persistBacktestRun(client,{runId:run.runId,signalName:query.signal,outcomeKind:query.outcome,
      fromAt:iso(0),toAt:new Date(base+86400000-1),horizonHours:1,threshold:0.5,
      baselineKind:"market_average",metrics:run.metrics,observations:run.observations,dataCutoffAt:iso(72)});
    assert.equal((await client.query("SELECT COUNT(*) AS n FROM backtest_results")).rows[0].n,"1");
    const next=await selectBacktestObservations(client,{...query,from:iso(24).slice(0,10),to:iso(24).slice(0,10)},iso(72));
    assert.equal(next.rows.length,1);
    assert.equal(next.rows[0].signal_at.toISOString(),iso(24.25));
  });
});
