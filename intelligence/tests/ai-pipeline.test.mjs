import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {createAiGateway} from "@claude-project/ai-gateway";
import {readCollectorMessage,readCollectorContext,isLowValueTelegramPost,runAiAnalysisBatch,registerModel,refreshTokenDailyCrossPlatform,
  evaluateCrossPlatformAlerts,persistAlertCandidates,ingestRegistryEvent,ingestTimelineEvent} from "../dist/index.js";
import {createAiRuntime} from "../scripts/ai-runtime.mjs";
import {buildTgSnapshotEvent} from "../scripts/backfill-core.mjs";
import {createIntelligenceApi} from "../api/server.mjs";
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
  const excludedAt=new Date();
  await f.destination.query(`INSERT INTO ai_message_attempts(source_system,source_event_kind,event_key,task,model_id,attempts,next_attempt_at,error_code)
    SELECT source_system,source_event_kind,event_key,'sentiment','test-sentiment',5,$1,'excluded_template_v1' FROM timeline_events WHERE source_system='tg'`,[excludedAt]);
  const filteredApi=await queryTokenApi(f.destination,{kind:'ai',tokenId:null,source:'tg',asOf:excludedAt.toISOString(),limit:20});
  assert.equal(filteredApi.items.length,0,"known filtered templates hide legacy AI results without deleting source data");
  const historical=await queryTokenApi(f.destination,{kind:'ai',tokenId:null,source:'tg',asOf:new Date(excludedAt.getTime()-1).toISOString(),limit:20});
  assert.equal(historical.items.length,2,"later filtering must not rewrite historical responses");
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
  assert.equal((await f.destination.query("SELECT error_code FROM ai_message_attempts")).rows[0].error_code,"ai_provider_http_error");
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


test("TG context is earlier, same-source, available by cutoff, unedited and non-template",{skip:!url},async t=>{
 const f=await fixture(t);const at=new Date(f.ms),before=new Date(f.ms-1000),future=new Date(f.ms+1000);
 await f.source.query("ALTER TABLE tg_messages ADD COLUMN edited_at TIMESTAMPTZ; INSERT INTO tg_sources VALUES(2,'-100456')");
 await f.source.query(`INSERT INTO tg_messages(source_id,message_id,text,collected_at,posted_at,deleted_at,edited_at) VALUES
   (1,1,'it still holding well wow',$1,$2,NULL,NULL),
   (1,2,'Gamble Found! card',$1,$2,NULL,NULL),
   (1,3,'deleted context',$1,$2,$1,NULL),
   (1,4,'not available at cutoff',$3,$2,NULL,NULL),
   (1,5,'edited after cutoff',$1,$2,NULL,$3),
   (1,6,'published after target',$1,$3,NULL,NULL),
   (1,8,'future message ID',$1,$2,NULL,NULL),
   (2,1,'different source',$1,$2,NULL,NULL)`,[at,before,future]);
 const context=await readCollectorContext(f.source,'tg','tg:message:-100123:7',at);
 assert.deepEqual(context.map(x=>x.evidenceRef),['tg:message:-100123:1']);
 assert.equal(context[0].text,'it still holding well wow');
 await f.source.query("UPDATE tg_messages SET edited_at=$1 WHERE message_id=7",[future]);
 assert.equal(await readCollectorMessage(f.source,'tg','tg:message:-100123:7',at),null);
});

test("template posts never bill AI, are durably excluded, and do not block the next conversational message",{skip:!url},async t=>{
 const f=await fixture(t);await importAiSourceSnapshots(f.source,f.destination,'tg',1);
 await f.source.query("UPDATE tg_messages SET text='🫡 Gamble Found! 🟩 The Ice Age Lion ($Sparta) MC: $15K'");
 const input={...f,source:'tg',readText:(ref,at)=>readCollectorMessage(f.source,'tg',ref,at)};
 const first=await runAiAnalysisBatch(input);assert.equal(first.filtered,2);assert.equal(first.failed,0);assert.equal(f.calls.length,0);
 assert.equal((await runAiAnalysisBatch(input)).filtered,0);assert.equal(f.calls.length,0);
 assert.equal((await f.destination.query("SELECT count(*) FROM ai_message_attempts WHERE error_code='excluded_template_v1' AND attempts=5")).rows[0].count,'2');
 await f.source.query("INSERT INTO tg_messages VALUES(1,8,'thought it would be rugged',$1,$1,NULL)",[new Date(f.ms+100)]);
 await importAiSourceSnapshots(f.source,f.destination,'tg',1);
 let reads=0;
 const batch=await runAiAnalysisBatch({...input,readContext:async()=>{reads++;return [{evidenceRef:'tg:message:-100123:6',text:'it still holding well wow',postedAt:new Date(f.ms-1000).toISOString(),observedAt:new Date(f.ms).toISOString()}];}});
 assert.equal(batch.analyzed,2);assert.equal(f.calls.length,2);assert.equal(reads,1);
 const stored=(await f.destination.query("SELECT result FROM ai_message_analyses WHERE task='sentiment'")).rows[0].result;
 assert.equal(stored.contextEvidence[0].evidenceRef,'tg:message:-100123:6');
 assert.equal(stored.contextEvidence[0].textSha256.length,64);assert.equal(JSON.stringify(stored).includes('holding well'),false);
 const api=await queryTokenApi(f.destination,parseApiRequest(`/api/intelligence/v1/ai?asOf=${new Date().toISOString()}&source=tg`));
 assert.equal(api.items[0].contextEvidence[0].evidenceRef,'tg:message:-100123:6');
 assert.equal(JSON.stringify(api).includes('holding well'),false);
});

test("format filter rejects known scanner cards but retains conversational warnings and jokes",()=>{
 for(const text of ['🫡 Gamble Found! 🟩 The Ice Age Lion ($Sparta) MC: 15K','🚀 Token started migration to Raydium','🔥$REKT: $251K >> $1M3 | Х5 | 1m','0xee9fcc99971e3da8dd8c97557387bd7b88927777','├ MC: 10K\n├ VOL: 20K\n└ HOLDERS: 100'])assert.equal(isLowValueTelegramPost(text),true,text);
 for(const text of ['it still holding well wow','thought id come back to it getting rugged','Don’t screw up my DCA’s lmao tryna bid better dips 😂','I ignore Gamble Found! posts; they are bot spam','Other UMI dumping hard expecting this one to hold the cat meta'])assert.equal(isLowValueTelegramPost(text),false,text);
});


test("synthetic dialogue regressions preserve negations and irony while removing repeated VIP cards",async()=>{
 const {retained,excluded}=JSON.parse(await readFile(new URL("./fixtures/telegram-filter-holdout.json",import.meta.url),"utf8"));
 for(const text of retained)assert.equal(isLowValueTelegramPost(text),false,text);
 for(const text of excluded)assert.equal(isLowValueTelegramPost(text),true,text);
 // A human discussing the same keywords is useful, not the repeated card shape.
 assert.equal(isLowValueTelegramPost("Don't buy VIP access just because DEX NOT PAID scares you; check liquidity yourself."),false);
});


test("runtime source filter -> context -> gateway failure/retry -> storage -> real HTTP API",{skip:!url},async t=>{
 const f=await fixture(t);
 await f.source.query("UPDATE tg_messages SET text='I feared a collapse, but it is still holding.'");
 await f.source.query(`INSERT INTO tg_messages VALUES
   (1,6,'The price is still holding',$1,$2,NULL),
   (1,8,'Gamble Found! synthetic card',$1,$1,NULL),
   (1,9,'#SAMPLE · VIP: x2\n├ Growth: x2\n└ DEX NOT PAID\nGet VIP access',$1,$1,NULL)`,[new Date(f.ms),new Date(f.ms-1000)]);
 const rows=(await f.source.query("SELECT m.*,s.peer_id FROM tg_messages m JOIN tg_sources s ON s.id=m.source_id WHERE message_id>=7")).rows;
 for(const row of rows){const event=buildTgSnapshotEvent(row);const tx=await f.destination.connect();try{
  await tx.query('BEGIN');await ingestRegistryEvent(tx,event.payload.registryEvent);await ingestTimelineEvent(tx,'tg',event.eventKind,event.payload.timelineEvent);await tx.query('COMMIT');
 }finally{tx.release();}}
 const originalFetch=globalThis.fetch;let calls=0,failNarrative=true,api;
 globalThis.fetch=async(input,init)=>{
  if(!String(input).startsWith('https://runtime.example.test/'))return originalFetch(input,init);
  calls++;const request=JSON.parse(init.body),supplied=JSON.parse(request.messages[1].content);
  assert.equal(supplied.context.length,1);assert.equal(supplied.context[0].evidenceRef,'tg:message:-100123:6');
  const narrative=request.messages[0].content.includes('narrative');
  if(narrative&&failNarrative){failNarrative=false;throw new Error('sensitive provider body must never persist');}
  const result=narrative?{narrativeId:null,confidence:0.9,keywords:[],evidenceRefs:supplied.evidenceRefs}:
    {label:'mixed',score:0,directionAmbiguous:true,confidence:0.9,evidenceRefs:supplied.evidenceRefs};
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
 };
 try{
  const env={AI_GATEWAY_ENABLED:'true',AI_DEFAULT_PROVIDER:'test',RUNTIME_TEST_KEY:'synthetic-key-only',
    AI_PROVIDERS_JSON:JSON.stringify([{id:'test',baseUrl:'https://runtime.example.test/v1',apiKeyEnv:'RUNTIME_TEST_KEY',chatModel:'test'}]),
    INTELLIGENCE_AI_ENABLED:'true',INTELLIGENCE_AI_BATCH_SIZE:'8',
    INTELLIGENCE_AI_MODELS_JSON:JSON.stringify(['sentiment','narrative'].map(task=>({modelId:'test-'+task,provider:'test',name:'test',version:'1',task})))};
  const runtime=await createAiRuntime(f.destination,{tg:f.source},env);
  const first=await runtime.run('tg');assert.equal(first.filtered,4);assert.equal(first.analyzed,1);assert.equal(first.failed,1);assert.equal(calls,2);
  const failed=(await f.destination.query("SELECT error_code FROM ai_message_attempts WHERE attempts=1")).rows;
  assert.deepEqual(failed,[{error_code:'ai_provider_network_error'}]);assert.equal(JSON.stringify(failed).includes('sensitive'),false);
  await runtime.run('tg');assert.equal(calls,2,'backoff must not rebill completed or filtered work');
  await f.destination.query("UPDATE ai_message_attempts SET next_attempt_at=clock_timestamp()-INTERVAL '1 second' WHERE attempts=1");
  assert.equal((await runtime.run('tg')).analyzed,1);assert.equal(calls,3,'retry only the failed task');
  const saved=(await f.destination.query('SELECT result FROM ai_message_analyses')).rows;assert.equal(saved.length,2);
  const apiToken='synthetic-runtime-api-token-1234567890';api=createIntelligenceApi({pool:f.destination,token:apiToken});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${api.address().port}/api/intelligence/v1/ai`;
  const response=await fetch(base+'?source=tg&asOf='+new Date().toISOString(),{headers:{Authorization:'Bearer '+apiToken}});
  assert.equal(response.status,200);const body=await response.json();assert.equal(body.items.length,2);
  assert.ok(body.items.every(item=>item.contextEvidence[0].evidenceRef==='tg:message:-100123:6'));
  assert.equal(JSON.stringify(body).includes('The price is still holding'),false);
  const past=await fetch(base+'?source=tg&asOf='+new Date(f.ms).toISOString(),{headers:{Authorization:'Bearer '+apiToken}});assert.equal((await past.json()).items.length,0);
  await runtime.run('tg');assert.equal(calls,3,'successful replay must not call provider');
 }finally{globalThis.fetch=originalFetch;if(api)await new Promise(resolve=>api.close(resolve));}
});
