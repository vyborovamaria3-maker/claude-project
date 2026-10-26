import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {readFile} from 'node:fs/promises';import pg from 'pg';import Database from 'better-sqlite3';
import {createAiGateway} from '@claude-project/ai-gateway';
import {isLowValueTelegramPost} from '../dist/index.js';
import {collectTokenInputs,analyzeTokenOnDemand,validateTokenInterpretation,mentionsAddress} from '../scripts/token-analysis.mjs';
import {createIntelligenceApi} from '../api/server.mjs';
import {requestTokenAnalysis} from '../../solana-launcher/lib/token-intelligence/on-demand-proxy.mjs';
const url=process.env.INTELLIGENCE_TEST_DB_URL,mint='So11111111111111111111111111111111111111112',tokenId='solana:'+mint;
const interpretation={stance:'mixed',score:0,directionAmbiguous:true,confidence:0.7,factIds:['tokenId'],evidenceRefs:['tg:message:123:2']};
test('on-demand request releases its client if advisory unlock disconnects',async()=>{
 let released=false;
 const destination={connect:async()=>({release(discard){assert.equal(discard,true);released=true;},async query(sql){
  if(sql.startsWith('SELECT model_id'))return {rows:[{model_id:'test',provider:'test',name:'test',version:'1'}]};
  if(sql.includes('pg_advisory_unlock'))throw new Error('disconnected during unlock');
  return {rows:[]};
 }})};
 const source={query:async()=>({rows:[]})};
 await assert.rejects(analyzeTokenOnDemand({destination,sources:{x:source,tg:source,chain:{prepare:()=>({all:()=>[]})}},
  gateway:{},modelId:'test',tokenId}),/disconnected during unlock/);
 assert.equal(released,true);
});
test('complete MonstaScan cards are excluded while human negations and comments survive',()=>{
 const card=`SAMPLE (Example)\n${mint}\n\nby MonstaScan\nCap: 1K\nVol: 2K\nBonding Curve: 50%\nTop 10 in detail\nUser |MCap |Buy |Sell |Left\nCopyright sample | pf_ultimate`;
 assert.equal(isLowValueTelegramPost(card),true);
 assert.equal(isLowValueTelegramPost("Do not trust the scanner.\n"+card),false);
 assert.equal(isLowValueTelegramPost(card+"\nThose figures are wrong; do not buy."),false);
 assert.equal(isLowValueTelegramPost('Do not trust by MonstaScan. Cap: 1K, Vol: 2K, Bonding Curve: 50%'),false);
});
test('on-demand grounding rejects invented facts/references/prose and address substrings',()=>{
 const input={facts:{tokenId},messages:[{evidenceRef:'tg:message:123:2'}],trades:[]};
 assert.equal(mentionsAddress(mint,mint),true);assert.equal(mentionsAddress('1'+mint,mint),false);
 assert.throws(()=>validateTokenInterpretation({...interpretation,factIds:['invented']},input),/facts_invalid/);
 assert.throws(()=>validateTokenInterpretation({...interpretation,evidenceRefs:['other']},input),/evidence_invalid/);
 assert.throws(()=>validateTokenInterpretation({...interpretation,prose:'guaranteed profit'},input),/output_invalid/);
 assert.equal(validateTokenInterpretation({...interpretation,stance:'bullish',score:1},input).score,0);
 assert.equal(validateTokenInterpretation({...interpretation,evidenceRefs:[]},{...input,messages:[]}).stance,'unknown');
});
test('explicit token POST joins independent source stores, grounds/persists, caches and never runs on GET',{skip:!url},async t=>{
 const admin=new pg.Pool({connectionString:url}),prefix='request_'+randomUUID().replaceAll('-','');const pools=[];let api;
 const make=async suffix=>{const schema=prefix+'_'+suffix;await admin.query('CREATE SCHEMA '+schema);const pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema,max:3});pools.push([schema,pool]);return pool;};
 const destination=await make('dst'),x=await make('x'),tg=await make('tg'),chain=new Database(':memory:');
 t.after(async()=>{if(api)await new Promise(r=>api.close(r));chain.close();for(const [schema,pool]of pools){await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');}await admin.end();});
 for(const name of ['001_entity_registry.sql','002_timeline.sql','003_feature_store.sql','004_token_link_observations.sql','005_blockchain_swap_evidence_revisions.sql','006_cross_platform_analytics.sql','008_alert_status_history.sql','009_ai_analysis.sql','010_intelligence_governance.sql'])await destination.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
 await destination.query(await readFile(new URL('../migrations/016_token_ai_requests.sql',import.meta.url),'utf8'));
 await destination.query("INSERT INTO model_registry(model_id,provider,name,version,task,status) VALUES('token-test','test','test','1','explanation','active')");
 await x.query('CREATE TABLE twitter_tweets(tweet_id TEXT,text TEXT,updated_at BIGINT,posted_at BIGINT)');
 await tg.query('CREATE TABLE tg_sources(id BIGINT,peer_id TEXT);CREATE TABLE tg_messages(source_id BIGINT,message_id BIGINT,text TEXT,collected_at TIMESTAMPTZ,posted_at TIMESTAMPTZ,deleted_at TIMESTAMPTZ,edited_at TIMESTAMPTZ)');
 chain.exec('CREATE TABLE token_trades(mint TEXT,signature TEXT,timestamp INTEGER,trader TEXT,type TEXT,amount_sol REAL,amount_tokens REAL,inserted_at INTEGER)');
 const ms=Date.now()-10000;
 await x.query('INSERT INTO twitter_tweets VALUES($1,$2,$3,$3)',['9','I would not buy '+mint,ms]);
 await tg.query("INSERT INTO tg_sources VALUES(1,'123')");
 await tg.query('INSERT INTO tg_messages VALUES(1,1,$1,$3,$3,NULL,NULL),(1,2,$2,$4,$4,NULL,NULL),(1,3,$5,$4,$4,NULL,NULL)', ['Still holding well','I feared a rug, but it held '+mint,new Date(ms-1000),new Date(ms),'Gamble Found! MC: 15K '+mint]);
 chain.prepare('INSERT INTO token_trades VALUES(?,?,?,?,?,?,?,?)').run(mint,'sample-signature',Math.floor(ms/1000),'sample-wallet','buy',2,100,ms);
 const sources={x,tg,chain};let calls=0;
 const gateway=createAiGateway({defaultProviderId:'test',providers:[{id:'test',baseUrl:'https://token.example.test/v1',apiKey:'test-only',chatModel:'test'}],maxAttempts:1,fetchImpl:async(_url,init)=>{
  calls++;const request=JSON.parse(init.body),supplied=JSON.parse(request.messages[1].content);
  assert.equal(supplied.facts['chain.sampledStoredTradeRows'],1);assert.equal(supplied.messages.length,2);assert.equal(supplied.messages.find(m=>m.source==='tg').context.length,1);
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(interpretation)}}],usage:{prompt_tokens:100,completion_tokens:50}}));
 }});
 const input=await collectTokenInputs(sources,tokenId);assert.equal(input.facts['tg.filteredTemplates'],1);
 const auth='s'.repeat(40);api=createIntelligenceApi({token:auth,pool:destination,analyzeToken:id=>analyzeTokenOnDemand({destination,sources,gateway,modelId:'token-test',tokenId:id})});
 await new Promise(r=>api.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+api.address().port+'/api/intelligence/v1/tokens/'+encodeURIComponent(tokenId)+'/analyze';
 assert.equal(calls,0);assert.equal((await fetch(base,{method:'POST'})).status,401);assert.equal(calls,0);
 assert.equal((await fetch(base,{headers:{Authorization:'Bearer '+auth}})).status,404);assert.equal(calls,0);
 assert.equal((await fetch(base,{method:'POST',body:'{}',headers:{Authorization:'Bearer '+auth}})).status,400);
 const headers={Authorization:'Bearer '+auth};const first=await(await fetch(base,{method:'POST',headers})).json();assert.equal(first.status,'analyzed');assert.equal(first.cached,false);assert.equal(calls,1);
 const second=await(await fetch(base,{method:'POST',headers})).json();assert.equal(second.cached,true);assert.equal(calls,1);
 assert.equal(JSON.stringify(first).includes('I feared'),false);assert.equal(first.grounding.selectedFactsVerified,true);
 const saved=(await destination.query('SELECT report FROM token_ai_requests')).rows;assert.equal(saved.length,1);assert.equal(saved[0].report.provider.inputTokens,100);
 const projected=await requestTokenAnalysis(mint,{env:{POTAPOFF_TOKEN_INTELLIGENCE_ENABLED:'true',INTELLIGENCE_API_TOKEN:auth,INTELLIGENCE_API_PORT:String(api.address().port)}});
 assert.equal(projected.analysisMode,'token_on_demand');assert.equal(projected.tokenAnalysis.cached,true);assert.equal(calls,1);assert.equal(JSON.stringify(projected).includes('traceId'),false);
 await x.query('UPDATE twitter_tweets SET text=$1,updated_at=$2',['Now I think this may recover '+mint,Date.now()]);
 await Promise.all([1,2,3].map(()=>analyzeTokenOnDemand({destination,sources,gateway,modelId:'token-test',tokenId})));assert.equal(calls,2,'new revision invalidates cache; concurrent identical requests share one call');
 await assert.rejects(analyzeTokenOnDemand({destination,sources:{...sources,x:{query:async()=>{throw new Error('source failure');}}},gateway,modelId:'token-test',tokenId}));assert.equal(calls,2,'source failure must not be treated as empty data or call AI');
});

test('ambiguous model output still requires verifiable fact IDs and supplied social evidence',()=>{
 const input={facts:{'x.sampledMessages':2,'tg.sampledMessages':0},messages:[{evidenceRef:'x:tweet:1'},{evidenceRef:'x:tweet:2'}],trades:[]};
 const value={stance:'mixed',score:0,directionAmbiguous:true,confidence:0.8,factIds:[],evidenceRefs:['x:tweet:1','x:tweet:2']};
 assert.throws(()=>validateTokenInterpretation(value,input),/facts_invalid/);
 const valid={...value,factIds:['x.sampledMessages','tg.sampledMessages']};
 assert.equal(validateTokenInterpretation(valid,input).score,0);
 assert.throws(()=>validateTokenInterpretation({...valid,evidenceRefs:['x:tweet:999']},input),/evidence_invalid/);
});
