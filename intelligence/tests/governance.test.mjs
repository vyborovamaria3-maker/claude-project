import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID,randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {recordAiCost,queueAnalyticsInvalidation,requireCurrentSignalValidation,storeEncryptedEventText,readEncryptedEventText} from "../dist/index.js";

const url=process.env.INTELLIGENCE_TEST_DB_URL;
const token="solana:So11111111111111111111111111111111111111112";
const migrations=["001_entity_registry.sql","002_timeline.sql","003_feature_store.sql",
  "004_token_link_observations.sql","005_blockchain_swap_evidence_revisions.sql",
  "006_cross_platform_analytics.sql","008_alert_status_history.sql","009_ai_analysis.sql",
  "010_intelligence_governance.sql","011_validation_preregistration.sql"];

test("Intelligence 2.2 PostgreSQL schema: as-of, coverage, validation, dedup and privacy",{
  skip:!url,
},async()=>{
  const db=new pg.Client({connectionString:url});
  await db.connect();
  try{
    await db.query("BEGIN");
    const schema="gov_"+randomUUID().replaceAll("-","");
    await db.query('CREATE SCHEMA "'+schema+'"');
    await db.query('SET LOCAL search_path TO "'+schema+'"');
    for(const migration of migrations)
      await db.query(await readFile(new URL("../migrations/"+migration,import.meta.url),"utf8"));
    await db.query("INSERT INTO feature_versions(feature_version,definition) VALUES('features-v1','{}')");
    const past="2020-01-01T00:00:00Z";
    await db.query(`INSERT INTO chain_token_features
      (canonical_token_id,as_of,max_input_observed_at,feature_version,features)
      VALUES ($1,$2,$2,'features-v1','{}')`,[token,past]);
    const {rows:[feature]}=await db.query("SELECT available_at,computed_at FROM chain_token_features");
    assert.ok(feature.available_at>=feature.computed_at);
    assert.ok(feature.available_at>new Date(past));

    const types=await db.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='event_text_snapshots'`);
    assert.ok(types.rows.some(r=>r.column_name==="text_ciphertext"));
    assert.ok(!types.rows.some(r=>r.column_name==="text"||r.column_name==="message_body"));

    const costId=randomUUID();
    assert.equal(await recordAiCost(db,{requestId:costId,providerId:"test",modelId:"test",
      task:"sentiment",estimatedCostUsd:0.004,inputTokens:12,outputTokens:3}),true);
    assert.equal(await recordAiCost(db,{requestId:costId,providerId:"test",modelId:"test",
      task:"sentiment",estimatedCostUsd:0.004,inputTokens:12,outputTokens:3}),false);
    const cost=await db.query("SELECT count(*)::integer AS count FROM ai_cost_ledger");
    assert.equal(cost.rows[0].count,1);

    const change={canonicalTokenId:token,sourceSystem:"x",eventKind:"tweet_edited",
      eventKey:"test:revision-1",reason:"edit"};
    assert.equal(await queueAnalyticsInvalidation(db,change),true);
    assert.equal(await queueAnalyticsInvalidation(db,change),false);
    const queued=await db.query("SELECT count(*)::integer AS count FROM analytics_invalidation_log");
    assert.equal(queued.rows[0].count,1);

    const signalVersion="cross-platform-heuristics-v2";
    const signalTime=new Date(Date.now()+3600000);
    assert.equal(await requireCurrentSignalValidation(db,signalVersion,signalTime),false);
    const runId=randomUUID();
    await db.query(`INSERT INTO backtest_runs(run_id,signal_name,outcome_kind,from_at,to_at,horizon_hours,
      threshold,baseline_kind,status,metrics,feature_version,started_at,completed_at,data_cutoff_at)
      VALUES($1,'attention_score','price_2x_24h',clock_timestamp()-INTERVAL '5 days',
        clock_timestamp()-INTERVAL '4 days',24,0.7,'market_average','completed',
        '{"sampleSize":25}','cross-platform-heuristics-v2',clock_timestamp()-INTERVAL '10 seconds',
        clock_timestamp(),clock_timestamp()-INTERVAL '5 seconds')`,[runId]);
    // PostgreSQL preserves microseconds that JS Date rounds away: copy the cutoff server-side.
    await db.query(`INSERT INTO signal_validation_registry
      (signal_version,backtest_run_id,method,method_params,reproducibility_hash,
        dataset_cutoff,validation_status,deployment_valid_until,validation_report)
      SELECT $1,run_id,'holdout','{"producer":"temporal_holdout_v1"}'::jsonb,$3,
        data_cutoff_at,'passed',$4::timestamptz,'{"pValue":0.001}'::jsonb FROM backtest_runs WHERE run_id=$2`,
      [signalVersion,runId,"a".repeat(64),new Date(Date.now()+86400000)]);
    assert.equal(await requireCurrentSignalValidation(db,signalVersion,signalTime),false,
      "fabricated validation without immutable preregistration cannot authorize an alert");
    // The authorization query must reject p>0.05, lift<2 and tiny holdout cohorts.
    assert.equal(await requireCurrentSignalValidation(db,signalVersion,new Date(Date.now()+2*86400000)),false);


    const eventId={sourceSystem:"tg",sourceEventKind:"message_observed",eventKey:"tg-test-v1"};
    const evidenceId="tg:message:-100123:42";
    await db.query(`INSERT INTO intelligence_inbox
      (source_system,event_kind,event_key,schema_version,evidence_source_id)
      VALUES('tg','message_observed',$1,'tg-message-v1',$2)`,[eventId.eventKey,evidenceId]);
    await db.query(`INSERT INTO timeline_events
      (source_system,source_event_kind,event_key,timeline_kind,occurred_at,observed_at,
        evidence_source_id,schema_version,payload)
      VALUES('tg','message_observed',$1,'tg_message_published',
        '2026-10-20T11:00:00Z','2026-10-20T12:00:00Z',$2,'timeline-v1','{}')`,
      [eventId.eventKey,evidenceId]);
    const key=randomBytes(32);
    assert.equal(await storeEncryptedEventText(db,{...eventId,
      observedAt:"2026-10-20T12:00:00Z",text:"Sensitive Telegram source post",
      key,keyRef:"fixture-key-v1",retentionDays:1}),true);
    assert.equal(await readEncryptedEventText(db,key,{...eventId,keyRef:"fixture-key-v1"}),
      "Sensitive Telegram source post");
    await db.query(`INSERT INTO intelligence_inbox
      (source_system,event_kind,event_key,schema_version,evidence_source_id)
      VALUES('tg','message_deleted','tg-test-delete','tg-message-v1',$1)`,[evidenceId]);
    assert.equal(await readEncryptedEventText(db,key,{...eventId,keyRef:"fixture-key-v1"}),null,
      "a delivered deletion tombstone must revoke previously encrypted text");
    const storedBytes=await db.query("SELECT text_ciphertext FROM event_text_snapshots");
    assert.equal(storedBytes.rows.length,1);
    assert.equal(storedBytes.rows[0].text_ciphertext.includes(Buffer.from("Sensitive Telegram")),false);

    const interpret=await db.query(`SELECT column_default FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='token_daily_cross_platform'
        AND column_name='score_interpretation'`);
    assert.ok(interpret.rows[0].column_default.includes("heuristic"));
    await db.query("ROLLBACK");
  }catch(error){try{await db.query("ROLLBACK")}catch{}throw error}
  finally{await db.end();}
});

test("governance helpers fail closed on invalid identifiers and expenses",async()=>{
  const db={async query(){throw new Error("Unexpected database query")}};
  await assert.rejects(recordAiCost(db,{requestId:"not-a-uuid",providerId:"test",
    modelId:"test",task:"sentiment"}),/Invalid cost identity/);
  await assert.rejects(queueAnalyticsInvalidation(db,{canonicalTokenId:"solana:fake",
    sourceSystem:"x",eventKind:"edit",eventKey:"1",reason:"edit"}),/Invalid invalidation identity/);
});
