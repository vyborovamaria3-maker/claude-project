import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {createAiGateway} from "@claude-project/ai-gateway";
import {readCollectorMessage,runAiAnalysisBatch,registerModel,refreshTokenDailyCrossPlatform,
  evaluateCrossPlatformAlerts,persistAlertCandidates} from "../dist/index.js";
import {importAiSourceSnapshots} from "../scripts/ai-source-snapshot.mjs";
import {parseApiRequest,queryTokenApi} from "../api/routes.mjs";

const url=process.env.INTELLIGENCE_TEST_DB_URL;
const token="solana:So11111111111111111111111111111111111111112";
async function fixture(t){
  const admin=new pg.Pool({connectionString:url});
  const schema="ai_"+randomUUID().replaceAll("-","");
  await admin.query(`CREATE SCHEMA ${schema}`);
  const destination=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:5});
  const source=new pg.Pool({connectionString:url,options:`-c search_path=${schema}_source`,max:2});
  await admin.query(`CREATE SCHEMA ${schema}_source`);
  t.after(async()=>{await source.end();await destination.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.query(`DROP SCHEMA ${schema}_source CASCADE`);await admin.end();});
  for(const file of ["001_entity_registry.sql","002_timeline.sql","003_feature_store.sql","004_token_link_observations.sql",
    "005_blockchain_swap_evidence_revisions.sql","006_cross_platform_analytics.sql","008_alert_status_history.sql","009_ai_analysis.sql"])
    await destination.query(await readFile(new URL("../migrations/"+file,import.meta.url),"utf8"));
  await source.query(`CREATE TABLE twitter_tweets(tweet_id TEXT PRIMARY KEY,author_id TEXT,text TEXT,updated_at BIGINT,posted_at BIGINT);
    CREATE TABLE tg_sources(id BIGINT PRIMARY KEY,peer_id TEXT);
    CREATE TABLE tg_messages(source_id BIGINT,message_id BIGINT,text TEXT,collected_at TIMESTAMPTZ,posted_at TIMESTAMPTZ,deleted_at TIMESTAMPTZ)`);
  const ms=Date.now()-3600000;
  await destination.query("INSERT INTO entity_registry(kind,canonical_id,first_seen_at,last_seen_at) VALUES('token',$1,$2,$2)",[token,new Date(ms)]);
  await source.query("INSERT INTO twitter_tweets VALUES ('123','456','Bullish launch',$1,$2)",[ms,ms-1000]);
  await source.query("INSERT INTO tg_sources VALUES(1,'-100123')");
  await source.query("INSERT INTO tg_messages VALUES(1,7,'Telegram launch',$1,$1,NULL)",[new Date(ms)]);
  for(const task of ["sentiment","narrative","explanation"])await registerModel(destination,{modelId:"test-"+task,
    provider:"test",name:"test",version:"1",task,status:"active"});
  const calls=[];
  let fail=false;
  const gateway=createAiGateway({providers:[{id:"test",baseUrl:"https://example.test/v1",apiKey:"test-key-only",chatModel:"test"}],
    defaultProviderId:"test",maxAttempts:1,fetchImpl:async(_url,init)=>{
      calls.push(JSON.parse(init.body));if(fail)return new Response("{}",{status:400});
      const supplied=JSON.parse(calls.at(-1).messages[1].content);
      const system=calls.at(-1).messages[0].content;
      const result=supplied.facts?{factIds:["alertType","asOf","score"],evidenceRefs:supplied.evidenceRefs}:
        system.includes("narrative")?{narrativeId:"test-launch",confidence:0.8,keywords:["launch"],evidenceRefs:supplied.evidenceRefs}:
        {label:"bullish",directionAmbiguous:false,score:0.75,confidence:0.8,evidenceRefs:supplied.evidenceRefs};
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:10,completion_tokens:20}}));
    }});
  return {destination,source,ms,calls,gateway,setFail:value=>{fail=value;},models:{sentiment:"test-sentiment",narrative:"test-narrative"}};
}

test("real PG source snapshots -> AI -> immutable storage -> API and as-of summary",{skip:!url},async t=>{
  const f=await fixture(t);
  assert.equal((await importAiSourceSnapshots(f.source,f.destination,"x",2)).imported,1);
  assert.equal((await importAiSourceSnapshots(f.source,f.destination,"tg",2)).imported,1);
  // Confirmed fixture token attribution is explicit; never infer it from AI prose.
  await f.destination.query(`INSERT INTO timeline_event_entities
    SELECT source_system,source_event_kind,event_key,'token',$1 FROM timeline_events WHERE source_system='x'`,[token]);
  const run=source=>runAiAnalysisBatch({...f,source,readText:(ref,at)=>readCollectorMessage(f.source,source,ref,at)});
  assert.equal((await run("x")).analyzed,2);
  assert.equal((await run("tg")).analyzed,2);
  assert.equal(f.calls.length,4);
  assert.equal((await run("x")).analyzed,0);assert.equal(f.calls.length,4);
  const saved=await f.destination.query("SELECT * FROM ai_message_analyses ORDER BY analysis_id");
  assert.equal(saved.rows.length,4);
  assert.ok(saved.rows.every(r=>r.text_sha256.length===64&&!JSON.stringify(r.result).includes('Bullish launch')));
  const now=new Date().toISOString();
  const response=await queryTokenApi(f.destination,parseApiRequest(`/api/intelligence/v1/tokens/${token}/ai?asOf=${now}`));
  assert.equal(response.items.length,2);
  const global=await queryTokenApi(f.destination,parseApiRequest(`/api/intelligence/v1/ai?asOf=${now}&source=tg`));
  assert.equal(global.items.length,2);
  const before=await queryTokenApi(f.destination,parseApiRequest(`/api/intelligence/v1/tokens/${token}/ai?asOf=${new Date(f.ms+1000).toISOString()}`));
  assert.equal(before.items.length,0);
  const tx=await f.destination.connect();
  try{
    await tx.query("BEGIN");
    const snapshot=await refreshTokenDailyCrossPlatform(tx,token,new Date(f.ms-1000).toISOString().slice(0,10),new Date());
    assert.equal(snapshot.xSentimentScore,0.75);
    assert.ok(Date.parse(snapshot.maxInputObservedAt)>=saved.rows[0].analyzed_at.getTime());
    await tx.query("ROLLBACK");
  }finally{tx.release();}
  await f.destination.query(`UPDATE ai_message_analyses SET result=result || '{"directionAmbiguous":true,"label":"mixed","score":0}'::jsonb WHERE source_system='x' AND task='sentiment'`);
  const ambiguous=await refreshTokenDailyCrossPlatform(f.destination,token,new Date(f.ms-1000).toISOString().slice(0,10),new Date());
  assert.equal(ambiguous.xMentions,1,"ambiguous sentiment does not erase the underlying mention");
  assert.equal(ambiguous.xSentimentScore,null,"message-wide opposing targets must not enter token sentiment averages as zero");
  const ambiguousApi=await queryTokenApi(f.destination,parseApiRequest(`/api/intelligence/v1/tokens/${token}/ai?asOf=${new Date().toISOString()}`));
  assert.equal(ambiguousApi.items.find(item=>item.task==='sentiment').result.directionAmbiguous,true);
  const sourceCount=(await f.source.query("SELECT count(*) FROM twitter_tweets")).rows[0].count;
  assert.equal(sourceCount,"1");
  await f.source.query("UPDATE twitter_tweets SET updated_at=$1,text='Revised launch'",[f.ms+2000]);
  await importAiSourceSnapshots(f.source,f.destination,"x",1);
  await f.destination.query(`INSERT INTO timeline_event_entities SELECT source_system,source_event_kind,event_key,'token',$1
    FROM timeline_events WHERE source_system='x' ON CONFLICT DO NOTHING`,[token]);
  const beforeReanalysis=await refreshTokenDailyCrossPlatform(f.destination,token,new Date(f.ms).toISOString().slice(0,10),new Date());
  assert.equal(beforeReanalysis.xMentions,1,"source revisions are not additional tweets");
  assert.equal(beforeReanalysis.xSentimentScore,null,"old text analysis cannot leak into a newer snapshot");
});

test("source reads refuse newer edits/deletions and support real X millisecond timestamps",{skip:!url},async t=>{
  const f=await fixture(t);
  assert.equal(await readCollectorMessage(f.source,"x","x:tweet:123",new Date(f.ms)),"Bullish launch");
  await f.source.query("UPDATE twitter_tweets SET updated_at=$1,text='new version'",[f.ms+1000]);
  assert.equal(await readCollectorMessage(f.source,"x","x:tweet:123",new Date(f.ms)),null);
  await f.source.query("UPDATE tg_messages SET deleted_at=clock_timestamp()");
  assert.equal(await readCollectorMessage(f.source,"tg","tg:message:-100123:7",new Date()),null);
  await assert.rejects(readCollectorMessage(f.source,"x","x:tweet:123;DROP",new Date()),/Invalid AI source/);
});

test("legacy X collector resolves stable author from its archive; handles never become identities",{skip:!url},async t=>{
  const f=await fixture(t);
  await f.source.query("ALTER TABLE twitter_tweets DROP COLUMN author_id; CREATE TABLE archive_posts(id TEXT PRIMARY KEY,author_id TEXT)");
  let imported=await importAiSourceSnapshots(f.source,f.destination,"x",1);
  assert.equal(imported.imported,1);assert.equal(imported.unattributed,1);
  assert.equal((await f.destination.query("SELECT 1 FROM entity_registry WHERE kind='author'")).rows.length,0);
  await f.source.query("INSERT INTO archive_posts VALUES('123','456')");
  imported=await importAiSourceSnapshots(f.source,f.destination,"x",1);
  assert.equal(imported.imported,1);
  const refs=await f.destination.query("SELECT canonical_id FROM entity_registry WHERE kind='author'");
  assert.equal(refs.rows[0].canonical_id,'x:456');
});

test("provider failures back off, busy workers do not bill, refresh retries without reanalysis",{skip:!url},async t=>{
  const f=await fixture(t);
  await importAiSourceSnapshots(f.source,f.destination,"x",1);
  await f.destination.query(`INSERT INTO timeline_event_entities
    SELECT source_system,source_event_kind,event_key,'token',$1 FROM timeline_events`,[token]);
  const input={...f,source:"x",models:{sentiment:"test-sentiment"},readText:(ref,at)=>readCollectorMessage(f.source,"x",ref,at)};
  f.setFail(true);
  assert.equal((await runAiAnalysisBatch(input)).failed,1);
  assert.equal((await runAiAnalysisBatch(input)).analyzed,0);assert.equal(f.calls.length,1);
  await f.destination.query("UPDATE ai_message_attempts SET next_attempt_at=clock_timestamp()-INTERVAL '1 second'");
  f.setFail(false);
  const first=await runAiAnalysisBatch({...input,refresh:async()=>{throw new Error('temporary_refresh_failure')}});
  assert.equal(first.analyzed,1);assert.equal(first.failed,0);assert.equal(first.refreshFailed,1);
  await f.destination.query("UPDATE ai_refresh_pending SET next_attempt_at=clock_timestamp()-INTERVAL '1 second'");
  const second=await runAiAnalysisBatch({...input,refresh:async()=>{}});
  assert.equal(second.refreshed,1);assert.equal(f.calls.length,2);
  const lock=await f.destination.connect();
  try{
    await lock.query("SELECT pg_advisory_lock(hashtextextended('intelligence-ai|x',0))");
    assert.equal((await runAiAnalysisBatch(input)).busy,true);assert.equal(f.calls.length,2);
  }finally{await lock.query("SELECT pg_advisory_unlock(hashtextextended('intelligence-ai|x',0))");lock.release();}
});

test("failed explanations have persistent bounded retry; valid grounding survives API",{skip:!url},async t=>{
  const f=await fixture(t),now=new Date().toISOString();
  const tx=await f.destination.connect();let id;
  try{await tx.query("BEGIN");[id]=await persistAlertCandidates(tx,evaluateCrossPlatformAlerts({canonicalTokenId:token,
    asOf:now,triggeredAt:now,maxInputObservedAt:now,tgMentions5m:75,scoreVersion:"test",evidenceRefs:["x:tweet:123"]}));
    await tx.query("COMMIT");}finally{tx.release();}
  const input={...f,source:"x",models:{explanation:"test-explanation"},readText:async()=>null};
  f.setFail(true);assert.equal((await runAiAnalysisBatch(input)).failed,1);
  await runAiAnalysisBatch(input);assert.equal(f.calls.length,1);
  await f.destination.query("UPDATE ai_explanation_attempts SET next_attempt_at=clock_timestamp()-INTERVAL '1 second'");
  f.setFail(false);assert.equal((await runAiAnalysisBatch(input)).explained,1);
  await runAiAnalysisBatch(input);assert.equal(f.calls.length,2);
  const stored=(await f.destination.query("SELECT * FROM signal_explanations WHERE alert_id=$1",[id])).rows[0];
  assert.equal(stored.grounding.version,"alert-facts-v1");assert.match(stored.explanation,/Score: 75/);
  const response=await queryTokenApi(f.destination,parseApiRequest(`/api/intelligence/v1/signals?asOf=${new Date().toISOString()}`));
  assert.equal(response.items[0].explanation.text,stored.explanation);
});
