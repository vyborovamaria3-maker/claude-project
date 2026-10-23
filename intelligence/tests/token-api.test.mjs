import test from "node:test";
import assert from "node:assert/strict";
import {request as httpRequest} from "node:http";
import {randomBytes} from "node:crypto";
import pg from "pg";
import {readFile} from "node:fs/promises";
import {
  buildEntityRef,buildEvidenceRef,buildTimelineEvent,
  buildVerifiedTokenLinkEvent,buildTokenLinksInvalidatedEvent,
  formatTokenId,formatSourceId,
} from "@claude-project/contracts";
import {
  ingestRegistryEvent,ingestTimelineEvent,ingestTokenLinkObservation,
} from "../dist/index.js";
import {createIntelligenceApi,checkApiReadiness,validateApiToken} from "../api/server.mjs";
import {apiConfiguration} from "../api/start.mjs";
import {parseApiRequest,queryTokenApi} from "../api/routes.mjs";

const token="f".repeat(43);
const mint="So11111111111111111111111111111111111111112";
const id=formatTokenId("solana",mint);
const at="2026-10-20T03:30:00.000Z";
const known="2026-10-20T03:00:00.000Z";
const occurred="2026-10-19T22:00:00.000Z";
const base="/api/intelligence/v1/tokens/"+encodeURIComponent(id);
const window="occurredBefore="+encodeURIComponent(occurred)+"&knownAt="+encodeURIComponent(known);

function fakePool(){
  const logs=[];
  return {
    logs,
    async query(sql,params){
      logs.push({sql,params});
      if(sql==="SELECT 1 AS ok")return {rows:[{ok:1}]};
      if(sql.includes("FROM ai_message_analyses"))return {rows:[{
        source_system:"x",evidence_ref:"x:tweet:1024",task:"sentiment",
        model_id:"sentiment-v1",model_version:"v1",provider_id:"SECRET-key",
        event_key:"SECRET-event",text:"SECRET source text",trace_id:"SECRET-trace",
        result:{label:"bullish",score:0.7,confidence:0.8,evidenceRefs:["x:tweet:1024","x:tweet:9999"],
          text:"SECRET raw source",providerKey:"SECRET-provider-key"},
        source_observed_at:new Date(occurred),analyzed_at:new Date(known),
      },{
        source_system:"tg",evidence_ref:"tg:message:-100123:42",task:"narrative",
        model_id:"narrative-v1",model_version:"v1",result:{narrativeId:"solana",confidence:0.9,
          keywords:["Solana"],evidenceRefs:["tg:message:-100123:42"]},
        source_observed_at:new Date(occurred),analyzed_at:new Date(known),
      }]};
      if(sql.includes("FROM token_daily_cross_platform"))return {rows:[{
        canonical_token_id:id,as_of:new Date(known),max_input_observed_at:new Date("2026-10-20T02:00:00Z"),
        tg_mentions:"5",tg_unique_authors:"3",tg_copypasta_ratio:"0.1",tg_sentiment_score:"0.4",tg_scam_ratio:"0.02",
        x_mentions:"7",x_unique_authors:"4",x_bot_ratio:"0.2",x_sentiment_score:"0.3",
        chain_trades:null,chain_transactions:"4",chain_swap_evidence_count:"2",chain_unique_wallets:"2",chain_volume_usd:null,chain_liquidity_usd:"5000",
        chain_smart_money_bought:"1",chain_rug_risk:"0.1",
        first_mention_tg_at:new Date(occurred),first_mention_x_at:new Date(occurred),first_trade_at:null,first_swap_evidence_at:new Date(occurred),
        attention_score:"3.2",credibility_score:"0.72",risk_score:"0.1",momentum_score:null,
        score_version:"cross-platform-heuristics-v2",score_reason:{attention:{used:["tg_mentions"]}},
        source_coverage:{tg:"partial",x:"partial",blockchain:"partial"},data_confidence:"0.8",
      }]};
      if(sql.includes("FROM chain_token_features"))return {rows:[{
        canonical_token_id:id,as_of:new Date(known),max_input_observed_at:new Date("2026-10-20T02:00:00Z"),
        feature_version:"features-v2",features:{mentions_5m:5,raw_message:"SECRET"},
      }]};
      if(sql.includes("FROM token_correlations"))return {rows:[{
        event_kind:"tg_first_mention",event_at:new Date(occurred),outcome_kind:"price_2x_24h",
        outcome_at:new Date("2026-10-20T22:00:00Z"),lift:"1.5",ci_low:"1.1",ci_high:"1.9",
        p_value:"0.02",baseline:{kind:"market_average"},sample_size:"100",
        evaluated_at:new Date(known),data_cutoff_at:new Date(known),model_id:null,
      }]};
      if(sql.includes("FROM token_alerts"))return {rows:[{
        alert_id:"12",canonical_token_id:id,alert_type:"attention_spike",severity:"medium",
        triggered_at:new Date(at),as_of:new Date(known),score:"2.4",score_version:"cross-platform-heuristics-v2",
        evidence_refs:["x:tweet:1024"],status:"open",
        explanation:"Recorded alert facts:\nAlert type: \"attention_spike\"\nInput cutoff: \""+known+"\"",
        explanation_model_id:"explanation-v1",explanation_created_at:new Date(at),
        explanation_evidence_refs:["x:tweet:1024","x:tweet:9999"],
        explanation_grounding:{version:"alert-facts-v1",factIds:["tokenId","alertType","asOf"]},
      }]};
      if(sql.includes("FROM backtest_runs"))return {rows:[{
        run_id:"00000000-0000-4000-8000-000000000001",signal_name:"attention_score",outcome_kind:"price_2x_24h",
        from_at:new Date("2025-01-01T00:00:00Z"),to_at:new Date("2025-09-30T23:59:59Z"),
        horizon_hours:24,threshold:"2",baseline_kind:"market_average",status:"completed",
        metrics:{sampleSize:100,pValue:0.04},started_at:new Date(known),completed_at:new Date(at),
        data_cutoff_at:new Date(known),feature_version:"features-v2",model_id:null,
      }]};
      if(sql.includes("FROM timeline_events")){
        return {rows:[{
          source_system:"x",timeline_kind:"tweet_published",
          event_key:"SECRET-event",payload:{text:"SECRET tweet body"},
          evidence_source_id:"x:tweet:1024",
          occurred_at:new Date(occurred),observed_at:new Date("2026-10-20T02:00:00Z"),
        }]};
      }
      if(sql.includes("FROM blockchain_swap_evidence_revisions")){
        return {rows:[{
          signature:"1".repeat(64),canonical_token_id:id,slot:"320000001",
          occurred_at:new Date(occurred),observed_at:new Date("2026-10-20T02:00:00Z"),
          wallet_id:"SECRET-wallet",raw_revision:"27",
        }]};
      }
      if(sql.includes("WITH latest AS")){
        return {rows:[{
          source_system:"tg",evidence_source_id:"tg:message:-100123:42",
          canonical_token_id:id,occurred_at:new Date(occurred),
          observed_at:new Date("2026-10-20T02:00:00Z"),
          source_revision_sha256:"a".repeat(64),
          event_key:"SECRET-revision",details:{apiKey:"SECRET-private-provider-data"},
        }]};
      }
      throw new Error("postgres://secret:password@private.internal");
    },
  };
}
async function withServer(pool,fn,opts={}){
  const server=createIntelligenceApi({token,pool,now:()=>new Date(at),...opts});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{return await fn("http://127.0.0.1:"+server.address().port,server)}
  finally{await new Promise(resolve=>server.close(resolve))}
}
function headers(extra={}){
  return {"Authorization":"Bearer "+token,...extra};
}

test("API config refuses public launch, short tokens and missing destination",()=>{
  assert.throws(()=>apiConfiguration({}),/api_explicit_opt_in_required/);
  assert.throws(()=>apiConfiguration({
    INTELLIGENCE_API_ENABLED:"true",INTELLIGENCE_API_TOKEN:"small",
  }),/api_token_configuration_invalid/);
  assert.throws(()=>apiConfiguration({
    INTELLIGENCE_API_ENABLED:"true",INTELLIGENCE_API_TOKEN:token,
  }),/intelligence_database_config_required/);
  assert.deepEqual(apiConfiguration({
    INTELLIGENCE_API_ENABLED:"true",INTELLIGENCE_API_TOKEN:token,
    INTELLIGENCE_DATABASE_URL:"postgres://localhost/test",
  }),{
    token,connectionString:"postgres://localhost/test",port:3182,
  });
  assert.throws(()=>validateApiToken("Bearer "+token));
});

test("strict token/time/query validation rejects aliases, encoded slashes, future leakage and duplicate filters",()=>{
  const now=new Date(at);
  assert.equal(parseApiRequest("/api/intelligence/v1/health",now).kind,"health");
  assert.equal(parseApiRequest(base+"/timeline?"+window+"&limit=3",now).limit,3);
  assert.equal(parseApiRequest(base+"/swap-evidence?"+window+"&limit=3",now).kind,"swap-evidence");
  assert.equal(parseApiRequest(base+"/summary?asOf="+encodeURIComponent(known),now).kind,"summary");
  assert.equal(parseApiRequest(base+"/features?asOf="+encodeURIComponent(known),now).kind,"features");
  assert.equal(parseApiRequest(base+"/correlations?asOf="+encodeURIComponent(known)+"&limit=2",now).limit,2);
  assert.equal(parseApiRequest(base+"/ai?asOf="+encodeURIComponent(known)+"&limit=2",now).kind,"ai");
  assert.deepEqual(parseApiRequest("/api/intelligence/v1/ai?asOf="+encodeURIComponent(known)+"&source=x",now),
    {kind:"ai",asOf:known,source:"x",tokenId:null,limit:50});
  assert.equal(parseApiRequest("/api/intelligence/v1/signals?asOf="+encodeURIComponent(known),now).kind,"signals");
  assert.equal(parseApiRequest("/api/intelligence/v1/backtest?signal=attention_score",now).kind,"backtest");
  for(const route of [
    base+"/timeline?"+window+"&limit=101",
    base+"/timeline?"+window+"&limit=0",
    base+"/timeline?"+window+"&limit=foo",
    base+"/timeline?"+window+"&limit=2&limit=4",
    base+"/timeline?"+window+"&unknown=1",
    base+"/timeline?knownAt="+encodeURIComponent(known),
    base+"/summary?asOf="+encodeURIComponent(known)+"&limit=2",
    base+"/ai?asOf="+encodeURIComponent(known)+"&limit=101",
    base+"/ai?asOf="+encodeURIComponent(known)+"&limit=1&limit=2",
    base+"/ai?asOf="+encodeURIComponent(known)+"&providerKey=private",
    "/api/intelligence/v1/ai?asOf="+encodeURIComponent(known)+"&source=blockchain",
    "/api/intelligence/v1/ai?asOf="+encodeURIComponent(known)+"&source=x&source=tg",
    base+"/ai?asOf="+encodeURIComponent("2026-10-20T23:30:00.000Z"),
    "/api/intelligence/v1/signals?asOf="+encodeURIComponent("2026-10-20T23:30:00.000Z"),
    base+"/links?"+window.replace(encodeURIComponent(known),encodeURIComponent("2026-10-20T23:30:00.000Z")),
    base+"/timeline?occurredBefore="+encodeURIComponent(at)+"&knownAt="+encodeURIComponent(known),
    "/api/intelligence/v1/tokens/SOL/timeline?"+window,
    "/api/intelligence/v1/tokens/solana%3A%2Fprivate/timeline?"+window,
    "/api/intelligence/v1/health?token="+token,
  ])assert.throws(()=>parseApiRequest(route,now),TypeError);
  assert.equal(parseApiRequest("/api/intelligence/v1/nope",now),null);
});

test("HTTP API enforces Bearer, no cookie/CORS, safe responses and read-only query limits",async()=>{
  const pool=fakePool();
  await withServer(pool,async origin=>{
    for(const reqHeaders of [{},{Cookie:"session=do-not-trust"},
      {Authorization:"Bearer "+token.slice(0,-1)+"g"}]){
      const r=await fetch(origin+base+"/timeline?"+window,{headers:reqHeaders});
      assert.equal(r.status,401);
      assert.equal(r.headers.get("access-control-allow-origin"),null);
      assert.equal(r.headers.get("cache-control"),"no-store, private");
    }
    const opt=await fetch(origin+base+"/timeline?"+window,{
      method:"OPTIONS",headers:headers(),
    });
    assert.equal(opt.status,405);
    const good=await fetch(origin+base+"/timeline?"+window+"&limit=1",{
      headers:headers(),
    });
    assert.equal(good.status,200);
    const body=await good.json();
    assert.equal(body.schemaVersion,"token-intelligence-v1");
    assert.equal(body.historicalCompleteness,"unknown");
    assert.equal(body.items.length,1);
    assert.equal(body.items[0].evidenceId,"x:tweet:1024");
    assert.equal(body.items[0].observedAt,"2026-10-20T02:00:00.000Z");
    assert.ok(!JSON.stringify(body).includes("SECRET"));
    assert.ok(!Object.hasOwn(body.items[0],"payload"));
    const link=await fetch(origin+base+"/links?"+window,{headers:headers()});
    assert.equal(link.status,200);
    const linked=await link.json();
    assert.equal(linked.items[0].evidenceId,"tg:message:-100123:42");
    assert.equal(linked.linkState,"active_as_known_at");
    assert.ok(!JSON.stringify(linked).includes("SECRET"));
    const swap=await fetch(origin+base+"/swap-evidence?"+window,{headers:headers()});
    assert.equal(swap.status,200);
    const swapBody=await swap.json();
    assert.equal(swapBody.items.length,1);
    assert.equal(swapBody.items[0].finality,"not_independently_verified");
    assert.equal(swapBody.tradeStatus,"not_a_confirmed_trade_tape");
    assert.ok(!JSON.stringify(swapBody).includes("SECRET"));
    const ready=await fetch(origin+"/api/intelligence/v1/health",{headers:headers()});
    assert.equal(ready.status,200);
    assert.equal((await ready.json()).sourceCollectorsChecked,false);
    const summary=await fetch(origin+base+"/summary?asOf="+encodeURIComponent(known),{headers:headers()});
    assert.equal(summary.status,200);
    const summaryBody=await summary.json();
    assert.equal(summaryBody.metrics.tgMentions,5);
    assert.equal(summaryBody.metrics.chainTransactions,4);
    assert.equal(summaryBody.metrics.chainSwapEvidenceCount,2);
    assert.equal(summaryBody.scores.risk,0.1);
    assert.equal(summaryBody.scores.interpretation.risk,"heuristic");
    assert.equal(summaryBody.scores.calibration,"not_probability");
    const summarySql=pool.logs.find(entry=>entry.sql.includes("FROM token_daily_cross_platform"))?.sql??"";
    assert.match(summarySql,/created_at <= \$2/); assert.match(summarySql,/ORDER BY day DESC,as_of DESC/);
    const features=await fetch(origin+base+"/features?asOf="+encodeURIComponent(known),{headers:headers()});
    assert.equal(features.status,200);
    const featuresBody=await features.json();
    assert.equal(featuresBody.featureVersion,"features-v2");
    const featureSql=pool.logs.find(entry=>entry.sql.includes("FROM chain_token_features"))?.sql??"";
    assert.match(featureSql,/computed_at <= \$2/);
    assert.ok(!JSON.stringify(featuresBody).includes("SECRET"));
    const ai=await fetch(origin+base+"/ai?asOf="+encodeURIComponent(known)+"&limit=1",{headers:headers()});
    assert.equal(ai.status,200);
    const aiBody=await ai.json();
    assert.equal(aiBody.truncated,true);
    assert.deepEqual(aiBody.items[0].result,{label:"bullish",score:0.7,confidence:0.8});
    assert.deepEqual(aiBody.items[0].evidenceRefs,["x:tweet:1024"]);
    assert.equal(aiBody.items[0].analyzedAt,known);
    assert.ok(!JSON.stringify(aiBody).includes("SECRET"));
    const aiQuery=pool.logs.find(entry=>entry.sql.includes("FROM ai_message_analyses"));
    assert.deepEqual(aiQuery.params,[id,known,2,null]);
    assert.match(aiQuery.sql,/analysis\.analyzed_at <= \$2/);
    assert.match(aiQuery.sql,/analysis\.source_observed_at <= \$2/);
    assert.match(aiQuery.sql,/inbox\.ingested_at <= \$2/);
    assert.match(aiQuery.sql,/entity\.kind='token' AND entity\.canonical_id=\$1/);
    assert.match(aiQuery.sql,/verified\.canonical_token_id=\$1/);
    assert.match(aiQuery.sql,/verified\.observed_at <= analysis\.analyzed_at/);
    assert.match(aiQuery.sql,/verified\.inserted_at <= analysis\.analyzed_at/);
    assert.match(aiQuery.sql,/invalidated\.observed_at >= LEAST\(verified\.observed_at,analysis\.source_observed_at\)/);
    assert.match(aiQuery.sql,/invalidated\.inserted_at <= \$2/);
    const correlations=await fetch(origin+base+"/correlations?asOf="+encodeURIComponent(at)+"&limit=5",{headers:headers()});
    assert.equal(correlations.status,200);
    assert.equal((await correlations.json()).items[0].pValue,0.02);
    const correlationSql=pool.logs.find(entry=>entry.sql.includes("FROM token_correlations"))?.sql??"";
    assert.match(correlationSql,/created_at <= \$2/);
    const signals=await fetch(origin+"/api/intelligence/v1/signals?asOf="+encodeURIComponent(at),{headers:headers()});
    assert.equal(signals.status,200);
    const signalBody=await signals.json();
    assert.equal(signalBody.items[0].alertType,"attention_spike");
    assert.equal(signalBody.items[0].explanation.grounding.version,"alert-facts-v1");
    assert.deepEqual(signalBody.items[0].explanation.evidenceRefs,["x:tweet:1024"]);
    const signalSql=pool.logs.find(entry=>entry.sql.includes("FROM token_alerts alert"))?.sql??"";
    assert.match(signalSql,/token_alert_status_history/); assert.match(signalSql,/changed_at <= \$1/);
    assert.match(signalSql,/created_at <= \$1 AND grounding->>'version'='alert-facts-v1'/);
    const backtests=await fetch(origin+"/api/intelligence/v1/backtest?signal=attention_score",{headers:headers()});
    assert.equal(backtests.status,200);
    assert.equal((await backtests.json()).items[0].metrics.sampleSize,100);
    assert.equal(pool.logs.length,10);
    assert.equal(pool.logs[0].params[0],id);
    assert.equal(pool.logs[0].params[3],2,"fetch limit+1 for truncation detection");
  });
});

test("AI API emits typed narrative fields and refuses malformed stored results or legacy explanation prose",async()=>{
  const body=await queryTokenApi(fakePool(),{kind:"ai",tokenId:id,asOf:known,limit:2});
  assert.deepEqual(body.items[1].result,{narrativeId:"solana",confidence:0.9,keywords:["Solana"]});
  assert.equal(body.truncated,false);
  for(const result of [
    {label:"bullish",score:2,confidence:0.8},
    {label:"forecast_100x",score:0.5,confidence:0.8},
    {label:"bullish",score:0.5,confidence:"0.8"},
    {label:"bullish",score:0.5,confidence:0.8,directionAmbiguous:true},
    {label:"mixed",score:0,confidence:0.8,directionAmbiguous:"true"},
    {label:"neutral",score:0,confidence:0.8,contextEvidence:[{evidenceRef:"tg:message:999:1",textSha256:"a".repeat(64),postedAt:occurred,observedAt:known}]},
  ])await assert.rejects(queryTokenApi({query:async()=>({rows:[{
    source_system:"x",evidence_ref:"x:tweet:1024",task:"sentiment",result,
    model_id:"sentiment-v1",model_version:"v1",source_observed_at:occurred,analyzed_at:known,
  }]})},{kind:"ai",tokenId:id,asOf:known,limit:1}),/invalid_stored_ai_(result|context)/);
  const signalPool=fakePool();
  const signals=await queryTokenApi({query:async(sql,params)=>{
    const result=await signalPool.query(sql,params);
    for(const row of result.rows){
      row.explanation="SECRET legacy unsupported forecast";
      row.explanation_grounding=null;
    }
    return result;
  }},{kind:"signals",asOf:at,limit:1});
  assert.equal(signals.items[0].explanation,null);
  assert.ok(!JSON.stringify(signals).includes("SECRET"));
});

test("HTTP HTTP parser refuses duplicated Authorization without evaluating SQL",async()=>{
  const pool=fakePool();
  await withServer(pool,async(origin)=>{
    const url=new URL(origin+base+"/timeline?"+window);
    const result=await new Promise((resolve,reject)=>{
      const req=httpRequest({
        hostname:url.hostname,port:url.port,path:url.pathname+url.search,method:"GET",
        headers:["Authorization","Bearer "+token,"Authorization","Bearer "+token],
      },res=>{
        res.resume();
        res.on("end",()=>resolve(res.statusCode));
      });
      req.on("error",reject);req.end();
    });
    assert.ok([400,401].includes(result),"duplicate auth is never accepted");
    assert.equal(pool.logs.length,0);
  });
});

test("database failures only return stable code; strict rate and capacity are bounded",async()=>{
  const pool={query:async()=>{throw new Error("postgres://admin:secret@host X session")}};
  await withServer(pool,async origin=>{
    const res=await fetch(origin+"/api/intelligence/v1/health",{headers:headers()});
    assert.equal(res.status,503);
    assert.deepEqual(await res.json(),{error:"intelligence_database_unavailable"});
  });
  const read=fakePool();
  await withServer(read,async origin=>{
    const first=await fetch(origin+"/api/intelligence/v1/health",{headers:headers()});
    assert.equal(first.status,200);
    const second=await fetch(origin+"/api/intelligence/v1/health",{headers:headers()});
    assert.equal(second.status,429);
    assert.equal(second.headers.get("retry-after"),"60");
    assert.equal(read.logs.length,1);
  },{requestsPerMinute:1});
});

test("readiness requires destination 001/002/004; no fallback to source databases",async()=>{
  const failed={query:async()=>({rows:[{
    inbox:true,timeline:true,entities:true,links:false,
  }]})};
  await assert.rejects(checkApiReadiness(failed),/migrations_001_002_004_required/);
  await assert.rejects(checkApiReadiness({query:async()=>({rows:[{
    inbox:true,timeline:true,entities:true,links:true,swap_revisions:false,
  }]})}),/migration_005_required/);
  await assert.rejects(checkApiReadiness({query:async()=>({rows:[{
    inbox:true,timeline:true,entities:true,links:true,swap_revisions:true,feature_store:false,
  }]})}),/migration_003_required/);
  await assert.rejects(checkApiReadiness({query:async()=>({rows:[{
    inbox:true,timeline:true,entities:true,links:true,swap_revisions:true,feature_store:true,
    model_registry:false,cross_platform:false,correlations:true,alerts:true,backtests:true,
  }]})}),/migration_006_required/);
  await assert.rejects(checkApiReadiness({query:async()=>({rows:[{
    inbox:true,timeline:true,entities:true,links:true,swap_revisions:true,feature_store:true,
    model_registry:true,cross_platform:true,correlations:true,alerts:true,backtests:true,alert_status_history:false,
  }]})}),/migration_008_required/);
  await assert.rejects(checkApiReadiness({query:async()=>({rows:[{
    inbox:true,timeline:true,entities:true,links:true,swap_revisions:true,feature_store:true,
    model_registry:true,cross_platform:true,correlations:true,alerts:true,backtests:true,alert_status_history:true,
    ai_message_analyses:false,explanation_grounding:false,
  }]})}),/migration_009_required/);
  await assert.doesNotReject(checkApiReadiness({query:async()=>({rows:[{
    inbox:true,timeline:true,entities:true,links:true,swap_revisions:true,feature_store:true,
    model_registry:true,cross_platform:true,correlations:true,alerts:true,backtests:true,alert_status_history:true,
    ai_message_analyses:true,explanation_grounding:true,
  }]})}));
});

test("real isolated PostgreSQL: token timeline and retraction-aware links are safe as-of",{
  skip:!process.env.INTELLIGENCE_TEST_DB_URL,
},async()=>{
  const url=process.env.INTELLIGENCE_TEST_DB_URL;
  const schema="api_v1_"+randomBytes(5).toString("hex");
  const admin=new pg.Client({connectionString:url});
  let pool;
  await admin.connect();
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');
    await admin.query('SET search_path TO "'+schema+'"');
    for(const file of ["001_entity_registry.sql","002_timeline.sql","003_feature_store.sql",
      "004_token_link_observations.sql","005_blockchain_swap_evidence_revisions.sql","006_cross_platform_analytics.sql",
      "008_alert_status_history.sql","009_ai_analysis.sql"]){
      await admin.query(await readFile(new URL("../migrations/"+file,import.meta.url),"utf8"));
    }
    pool=new pg.Pool({connectionString:url,options:"-c search_path="+schema,max:3});
    await checkApiReadiness(pool);
    const triggerAt=new Date(Date.now()-1_000).toISOString();
    const insertedAlert=await pool.query(`INSERT INTO token_alerts
      (canonical_token_id,alert_type,severity,triggered_at,as_of,score_version,features,evidence_refs)
      VALUES ($1,'api_status_history_test','low',$2,$2,'test','{}'::jsonb,'[]'::jsonb) RETURNING alert_id`,[id,triggerAt]);
    const alertId=insertedAlert.rows[0].alert_id;
    const initialHistory=(await pool.query(`SELECT status,changed_at FROM token_alert_status_history WHERE alert_id=$1 ORDER BY history_id ASC LIMIT 1`,[alertId])).rows[0];
    await new Promise(resolve=>setTimeout(resolve,10));
    await pool.query("UPDATE token_alerts SET status='delivered' WHERE alert_id=$1",[alertId]);
    const transitionHistory=await pool.query(`SELECT status FROM token_alert_status_history WHERE alert_id=$1 ORDER BY history_id ASC`,[alertId]);
    assert.deepEqual(transitionHistory.rows.map(row=>row.status),["open","delivered"]);
    const statusAsOf=await pool.query(`SELECT status FROM token_alert_status_history WHERE alert_id=$1 AND changed_at <= $2::timestamptz + INTERVAL '1 millisecond' ORDER BY changed_at DESC,history_id DESC LIMIT 1`,[alertId,initialHistory.changed_at]);
    assert.equal(statusAsOf.rows[0].status,"open");
    const firstAt="2026-10-20T02:00:00.000Z";
    const revokedAt="2026-10-20T02:30:00.000Z";
    const author=buildEntityRef({kind:"author",canonicalId:"x:123",firstSeenAt:firstAt,lastSeenAt:firstAt});
    const entity=buildEntityRef({kind:"token",canonicalId:id,firstSeenAt:firstAt,lastSeenAt:firstAt});
    const evidence=buildEvidenceRef({sourceKind:"x_tweet",tweetId:"1024",
      occurredAt:occurred,observedAt:firstAt});
    const registry={
      sourceSystem:"x",eventKind:"tweet_observed",eventKey:"x:1024:test",
      schemaVersion:"v1",entityRefs:[author,entity],evidenceRef:evidence,
    };
    await ingestRegistryEvent(pool,registry);
    await ingestTimelineEvent(pool,"x","tweet_observed",buildTimelineEvent({
      eventKey:registry.eventKey,kind:"tweet_published",
      occurredAt:occurred,observedAt:firstAt,entityRefs:[author,entity],
      evidenceRef:evidence,payload:{text:"SECRET sensitive X payload"},
    }));
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS n "+
      "FROM intelligence_inbox WHERE ingested_at<='2026-10-20T02:10:00Z'")).rows[0].n,0,
      "unavailable future destination ingestion must not leak into past");
    await pool.query("UPDATE intelligence_inbox SET ingested_at='2026-10-20T02:01:00Z' "+
      "WHERE source_system='x' AND event_key='x:1024:test'");
    const source=buildEntityRef({kind:"source",
      canonicalId:formatSourceId("tg","-100123"),
      firstSeenAt:firstAt,lastSeenAt:firstAt});
    const tgEvidence=(observedAt)=>buildEvidenceRef({
      sourceKind:"tg_message",sourceAccountId:"-100123",messageId:"42",
      occurredAt:occurred,observedAt,parserVersion:"tg-mint-verifier-v1",
    });
    const verified=buildVerifiedTokenLinkEvent({
      sourceSystem:"tg",sourceEntity:source,evidenceRef:tgEvidence(firstAt),
      mint,matchedLiteralMint:mint,sourceRevisionSha256:"a".repeat(64),
      mintVerification:{chainId:"solana-mainnet",method:"spl_mint_account",
        provider:"alchemy-solana-rpc",
        tokenProgram:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        checkedAt:firstAt},
    });
    const invalidated=buildTokenLinksInvalidatedEvent({
      sourceSystem:"tg",sourceEntity:source,evidenceRef:tgEvidence(revokedAt),
      reason:"edited",sourceRevisionSha256:"b".repeat(64),
    });
    for(const event of [verified,invalidated]){
      await ingestRegistryEvent(pool,event.payload.registryEvent);
      await ingestTokenLinkObservation(pool,event);
    }
    await pool.query("UPDATE token_link_observations SET inserted_at=observed_at");
    const tgRegistry={sourceSystem:"tg",eventKind:"message_observed",eventKey:"tg:42:api",
      schemaVersion:"v1",entityRefs:[source],evidenceRef:tgEvidence(firstAt)};
    await ingestRegistryEvent(pool,tgRegistry);
    await ingestTimelineEvent(pool,"tg","message_observed",buildTimelineEvent({
      eventKey:tgRegistry.eventKey,kind:"tg_message_published",occurredAt:occurred,
      observedAt:firstAt,entityRefs:[source],evidenceRef:tgEvidence(firstAt),payload:{text:"SECRET TG content"},
    }));
    await pool.query("UPDATE intelligence_inbox SET ingested_at='2026-10-20T02:01:00Z' "+
      "WHERE source_system='tg' AND event_key='tg:42:api'");
    await pool.query(`INSERT INTO model_registry(model_id,provider,name,version,task,status)
      VALUES ('api-sentiment-v1','fixture','fixture','v1','sentiment','active')`);
    const analyzedAt="2026-10-20T02:15:00.000Z";
    for(const [sourceSystem,sourceEventKind,eventKey,evidenceRef] of [
      ["x","tweet_observed",registry.eventKey,"x:tweet:1024"],
      ["tg","message_observed",tgRegistry.eventKey,"tg:message:-100123:42"],
    ])await pool.query(`INSERT INTO ai_message_analyses
      (source_system,source_event_kind,event_key,evidence_ref,canonical_token_ids,text_sha256,task,
       model_id,model_version,provider_id,trace_id,result,source_observed_at,analyzed_at)
      VALUES ($1,$2,$3,$4,'[]'::jsonb,$5,'sentiment','api-sentiment-v1','v1','fixture',
        '00000000-0000-4000-8000-000000000001',$6::jsonb,$7,$8)`,
    [sourceSystem,sourceEventKind,eventKey,evidenceRef,"a".repeat(64),
      JSON.stringify({label:"neutral",score:0,confidence:0.8,evidenceRefs:[evidenceRef],rawText:"SECRET"}),
      firstAt,analyzedAt]);
    await withServer(pool,async origin=>{
      const earlier="occurredBefore="+encodeURIComponent(occurred)+"&knownAt="+encodeURIComponent("2026-10-20T02:10:00Z");
      const later="occurredBefore="+encodeURIComponent(occurred)+"&knownAt="+encodeURIComponent("2026-10-20T02:50:00Z");
      const rawSwaps=await fetch(origin+base+"/swap-evidence?"+earlier,{headers:headers()});
      assert.equal(rawSwaps.status,200);
      assert.equal((await rawSwaps.json()).items.length,0,
        "no blockchain evidence cannot be promoted to a trade");
      const tl=await fetch(origin+base+"/timeline?"+earlier,{headers:headers()});
      assert.equal(tl.status,200);
      const payload=await tl.json();
      assert.equal(payload.items.length,1);
      assert.ok(!JSON.stringify(payload).includes("SECRET"));
      const old=await fetch(origin+base+"/links?"+earlier,{headers:headers()});
      assert.equal(old.status,200);
      assert.equal((await old.json()).items.length,1);
      const latest=await fetch(origin+base+"/links?"+later,{headers:headers()});
      assert.equal(latest.status,200);
      assert.equal((await latest.json()).items.length,0);
      const aiAt=async asOf=>{
        const response=await fetch(origin+base+"/ai?asOf="+encodeURIComponent(asOf),{headers:headers()});
        assert.equal(response.status,200);
        return response.json();
      };
      assert.equal((await aiAt("2026-10-20T02:10:00Z")).items.length,0,
        "analysis unavailable until it has actually completed");
      const classified=await aiAt("2026-10-20T02:20:00Z");
      assert.deepEqual(classified.items.map(item=>item.source).sort(),["tg","x"],
        "direct token attribution and existing verified links both expose their analyses");
      assert.ok(!JSON.stringify(classified).includes("SECRET"));
      assert.deepEqual((await aiAt("2026-10-20T02:50:00Z")).items.map(item=>item.source),["x"],
        "known token-link invalidation suppresses stale message analysis");
      const reverified=buildVerifiedTokenLinkEvent({
        sourceSystem:"tg",sourceEntity:source,evidenceRef:tgEvidence("2026-10-20T03:00:00Z"),
        mint,matchedLiteralMint:mint,sourceRevisionSha256:"c".repeat(64),
        mintVerification:{chainId:"solana-mainnet",method:"spl_mint_account",provider:"alchemy-solana-rpc",
          tokenProgram:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",checkedAt:"2026-10-20T03:00:00Z"},
      });
      await ingestRegistryEvent(pool,reverified.payload.registryEvent);
      await ingestTokenLinkObservation(pool,reverified);
      await pool.query("UPDATE token_link_observations SET inserted_at=observed_at");
      assert.deepEqual((await aiAt("2026-10-20T03:10:00Z")).items.map(item=>item.source),["x"],
        "later reverified revision must not resurrect analysis of the earlier message");
      assert.equal((await aiAt("2026-10-20T02:20:00Z")).items.length,2,
        "later corrections preserve the earlier as-of view");
    });
  }finally{
    if(pool)await pool.end();
    await admin.query("SET search_path TO public");
    await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
    await admin.end();
  }
});
