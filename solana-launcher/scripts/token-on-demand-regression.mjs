import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {requestTokenAnalysis,readTokenAnalysisRequest} from '../lib/token-intelligence/on-demand-proxy.mjs';
const mint='So11111111111111111111111111111111111111112',env={POTAPOFF_TOKEN_INTELLIGENCE_ENABLED:'true',INTELLIGENCE_API_TOKEN:'s'.repeat(40)};
function fixture(){return {
 version:'token-request-v1',tokenId:'solana:'+mint,status:'analyzed',asOf:'2026-10-24T00:00:00Z',
 facts:{tokenId:'solana:'+mint,'x.sampledMessages':1,'tg.sampledMessages':0,'tg.filteredTemplates':0,
  'chain.sampledStoredTradeRows':0,'chain.sampledWallets':0,'chain.coverage':'unknown',
  'social.coverage':'unknown','identity.method':'literal-address-match; stored-trade-mint'},
 summary:[{id:'tokenId',value:'solana:'+mint}],
 interpretation:{stance:'bullish',score:0.7,confidence:0.8,directionAmbiguous:false,
  factIds:['x.sampledMessages'],evidenceRefs:['x:tweet:123']},
 sourceStatus:{x:{queried:true,truncated:false},tg:{queried:true,truncated:false},
  blockchain:{queried:true,truncated:false,kind:'stored-trade-records-not-verified-settlement'}},
 grounding:{version:'token-request-v1',selectedFactsVerified:true,stance:'model-classification-not-fact',coverage:'unknown'},
 evidence:[{source:'x',evidenceRef:'x:tweet:123',textHash:'a'.repeat(64),observedAt:'2026-10-23T00:00:00Z',contextEvidence:[]}],
 provider:{apiKey:'must-not-return'},secret:'must-not-return'
};}
test('on-demand UI uses a fixed authenticated POST, drops arbitrary upstream fields and rejects ungrounded summary',async()=>{
 let calls=0;
 const report=fixture();
 const fetchImpl=async(url,init)=>{calls++;assert.equal(url,'http://127.0.0.1:3182/api/intelligence/v1/tokens/'+encodeURIComponent('solana:'+mint)+'/analyze');assert.equal(init.method,'POST');assert.equal(init.body,undefined);assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer '+env.INTELLIGENCE_API_TOKEN);return new Response(JSON.stringify(report));};
 const result=await requestTokenAnalysis(mint,{env,fetchImpl});assert.equal(calls,1);assert.equal(JSON.stringify(result).includes('must-not-return'),false);
 report.summary[0].value='forged';await assert.rejects(requestTokenAnalysis(mint,{env,fetchImpl}),/token_analysis_invalid/);
 await assert.rejects(requestTokenAnalysis('../bad',{env,fetchImpl}));assert.equal(calls,2);
});
test('social AI on-demand branch requires user auth and rate limit before proxy; no client snapshot is forwarded',async()=>{
 const source=await readFile(new URL('../app/api/trade/social-ai/route.ts',import.meta.url),'utf8');
 const branch=source.slice(source.indexOf("if(process.env.INTELLIGENCE_AI_ON_DEMAND_ENABLED==='true')"),source.indexOf('  const timeline ='));
 assert.ok(branch.indexOf('requireProdAuth')<branch.indexOf('requestTokenAnalysis'));
 assert.ok(branch.indexOf('checkRateLimit')<branch.indexOf('requestTokenAnalysis'));
 assert.ok(branch.indexOf('requireProdAuth')<branch.indexOf('readTokenAnalysisRequest'));
 assert.ok(branch.indexOf('checkRateLimit')<branch.indexOf('readTokenAnalysisRequest'));
 assert.match(branch,/requestTokenAnalysis\(mint\)/);assert.doesNotMatch(branch,/body\.snapshot|runQwen/);
});

test('nested fields are allowlisted and malformed known facts fail closed',async()=>{
 const report=fixture();
 for(const target of [report.facts,report.summary[0],report.interpretation,report.sourceStatus,
  report.sourceStatus.x,report.grounding,report.evidence[0]])target.privateField='nested-secret';
 const fetchImpl=async()=>new Response(JSON.stringify(report));
 const result=await requestTokenAnalysis(mint,{env,fetchImpl});
 assert.equal(JSON.stringify(result).includes('nested-secret'),false);
 report.summary.push({id:'privateField',value:'nested-secret'});
 await assert.rejects(requestTokenAnalysis(mint,{env,fetchImpl}),/token_analysis_invalid/);
 report.summary.pop();report.facts['x.sampledMessages']={apiKey:'nested-secret'};
 await assert.rejects(requestTokenAnalysis(mint,{env,fetchImpl}),/token_analysis_invalid/);
});
test('invalid upstream timestamps, confidence, evidence and source shapes are rejected',async()=>{
 for(const mutate of [r=>r.asOf='2026-02-30T00:00:00Z',r=>r.interpretation.confidence='0.8',
  r=>r.evidence[0].textHash='private prose',r=>r.sourceStatus.x.queried='yes']){
  const report=fixture();mutate(report);
  await assert.rejects(requestTokenAnalysis(mint,{env,fetchImpl:async()=>new Response(JSON.stringify(report))}),/token_analysis_invalid/);
 }
});
test('request parser validates JSON shapes and stops a chunked body at its limit',async()=>{
 for(const value of [null,[],{}, {mint:42}]){
  const req=new Request('http://localhost',{method:'POST',body:JSON.stringify(value)});
  await assert.rejects(readTokenAnalysisRequest(req),/invalid_mint/);
 }
 const req=new Request('http://localhost',{method:'POST',body:JSON.stringify({mint})});
 assert.deepEqual(await readTokenAnalysisRequest(req),{mint});
 let cancelled=false;
 const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(65537));},cancel(){cancelled=true;}});
 await assert.rejects(readTokenAnalysisRequest({headers:new Headers(),body}),/request_too_large/);
 assert.equal(cancelled,true);
});
test('request-only panel does not depend on legacy sources and never analyzes on mount',async()=>{
 const panel=await readFile(new URL('../components/trade/SocialIntelligencePanel.tsx',import.meta.url),'utf8');
 const page=await readFile(new URL('../app/trade/analysis/social/page.tsx',import.meta.url),'utf8');
 const start=panel.indexOf('      if(requestOnly){'),end=panel.indexOf('      const { x: xParams',start),branch=panel.slice(start,end);
 assert.ok(start>0);assert.match(branch,/body:JSON.stringify\(\{mint:contract\}\)/);assert.match(branch,/return;/);
 assert.ok(start<panel.indexOf('const chainPromise'));
 assert.match(panel,/if \(!requestOnly && initialMint/);assert.match(panel,/if\(requestOnly\)return;/);
 assert.match(panel,/requestOnly && <TokenRequestPanel/);assert.match(page,/requestOnly=\{process.env.INTELLIGENCE_AI_ON_DEMAND_ENABLED === "true"\}/);
});

test('new exclusion counters survive strict projection; old cached reports remain compatible',async()=>{
 const report=fixture();report.facts['x.filteredTemplates']=9;report.facts['x.duplicateMessages']=6;
 report.summary.push({id:'x.duplicateMessages',value:6});report.interpretation.factIds.push('x.duplicateMessages');
 const result=await requestTokenAnalysis(mint,{env,fetchImpl:async()=>new Response(JSON.stringify(report))});
 assert.equal(result.tokenAnalysis.facts['x.filteredTemplates'],9);assert.equal(result.tokenAnalysis.facts['x.duplicateMessages'],6);
 assert.match(result.result.summary,/Twitter — 9; повторов Twitter — 6/);
 for(const value of [-1,97,null,'6',{secret:'private'}]){report.facts['x.duplicateMessages']=value;await assert.rejects(requestTokenAnalysis(mint,{env,fetchImpl:async()=>new Response(JSON.stringify(report))}),/token_analysis_invalid/);}
 const old=await requestTokenAnalysis(mint,{env,fetchImpl:async()=>new Response(JSON.stringify(fixture()))});
 assert.equal(old.tokenAnalysis.facts['x.duplicateMessages'],0);
});
test('author caveats reach the visible summary, stay bounded and do not leak nested fields',async()=>{
 const report=fixture();report.interpretation.caveats=[{evidenceRef:'x:tweet:123',quote:'I like it, but liquidity is low',privateField:'must-not-return'}];
 const result=await requestTokenAnalysis(mint,{env,fetchImpl:async()=>new Response(JSON.stringify(report))});
 assert.match(result.result.summary,/I like it, but liquidity is low/);assert.match(result.result.summary,/не проверенные факты/);assert.equal(JSON.stringify(result).includes('must-not-return'),false);
 for(const caveats of [null,[{evidenceRef:'x:tweet:999',quote:'low liquidity'}],[{evidenceRef:'x:tweet:123',quote:'x'.repeat(241)}]]){
  report.interpretation.caveats=caveats;await assert.rejects(requestTokenAnalysis(mint,{env,fetchImpl:async()=>new Response(JSON.stringify(report))}),/token_analysis_invalid/);
 }
});
