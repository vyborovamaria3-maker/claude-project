import test from'node:test';import assert from'node:assert/strict';import{analyzeTokenOnDemand,tokenAnalysisFingerprint}from'../scripts/token-analysis.mjs';
const mint='So11111111111111111111111111111111111111112',text='I expect the price of '+mint+' to fall.',at=Date.now()-1000;
test('missing X context and unseen media survive the full request/save path without masking explicit criticism',async()=>{
 let supplied,saved,calls=0;
 const x={query:async()=>({rows:[{tweet_id:'1',text,updated_at:at,posted_at:at}]}),connect:async()=>({release(){},async query(sql){if(sql.includes('to_regclass'))return{rows:[{observations:'twitter_tweet_observations'}]};if(sql.startsWith('SELECT o.raw'))return{rows:[{raw:{id:'1',text,relatedPostIds:['2'],media:[{type:'photo'}]},posted_at:at}]};return{rows:[]}}})};
 const destination={connect:async()=>({release(){},async query(sql,args){if(sql.startsWith('SELECT model_id'))return{rows:[{model_id:'m',provider:'p',name:'model',version:'1'}]};if(sql.startsWith('INSERT INTO token_ai_requests'))saved=JSON.parse(args[3]);return{rows:[]}}})};
 const gateway={chatCompletion:async request=>{calls++;supplied=JSON.parse(request.messages[1].content);return{content:JSON.stringify({messageViews:[{evidenceRef:'x:tweet:1',target:'token',stance:'bearish',reading:'literal',contextRefs:[],contextUse:'not_needed'}],caveats:[],stance:'bearish',score:-0.6,directionAmbiguous:false,confidence:0.8,factIds:['x.sampledMessages','tg.sampledMessages'],evidenceRefs:['x:tweet:1']}),traceId:'11111111-1111-4111-8111-111111111111',providerId:'p',inputTokens:1,outputTokens:1,estimatedCostUsd:0}}};
 const report=await analyzeTokenOnDemand({destination,sources:{x,tg:{query:async()=>({rows:[]})},chain:{prepare:()=>({all:()=>[]})}},gateway,modelId:'m',tokenId:'solana:'+mint});
 assert.equal(calls,1);assert.equal(supplied.messages[0].contextAvailability,'unavailable');assert.deepEqual(supplied.messages[0].unavailableContextRefs,['x:tweet:2']);assert.equal(supplied.messages[0].hasUnseenMedia,true);assert.equal(report.interpretation.stance,'bearish');assert.equal(saved.evidence[0].hasUnseenMedia,true);assert.equal(saved.evidence[0].contextAvailability,'unavailable');
});
test('context ablation and missing-source metadata cannot reuse a full-context cache entry',()=>{
 const base={asOf:new Date().toISOString(),messages:[{evidenceRef:'x:tweet:1',text,context:[{evidenceRef:'x:tweet:2',text:'Earlier price assessment',relation:'linked_post'}]}]},without=structuredClone(base);without.messages[0].context=[];
 assert.notEqual(tokenAnalysisFingerprint('m',base),tokenAnalysisFingerprint('m',without));const missing=structuredClone(without);Object.assign(missing.messages[0],{contextAvailability:'unavailable',unavailableContextRefs:['x:tweet:2']});assert.notEqual(tokenAnalysisFingerprint('m',without),tokenAnalysisFingerprint('m',missing));
 const strip=input=>{const copy=structuredClone(input);delete copy.messages[0].context;return copy};assert.deepEqual(strip(base),strip(without));
});

function contextualRequestFixture(answer,target='Maybe participants are not departing because this asset failed. '+mint){
 const parent='They are leaving because access is inconvenient, not because the asset failed. Earlier enthusiasm did not resolve that complaint.';
 let supplied,calls=0,failed=false;const saved=new Map();
 const x={query:async()=>({rows:[{tweet_id:'1',text:target,updated_at:at,posted_at:at}]}),connect:async()=>({release(){},async query(sql){
  if(sql.includes('to_regclass'))return{rows:[{observations:'twitter_tweet_observations'}]};
  if(sql.startsWith('SELECT o.raw'))return{rows:[{raw:{id:'1',text:target,replyToPostId:'2'},posted_at:at}]};
  if(sql.startsWith('SELECT raw,observed_at'))return{rows:[{raw:{id:'2',text:parent,postedAt:at-1000},observed_at:new Date(at-500)}]};
  return{rows:[]};
 }})};
 const destination={connect:async()=>({release(){},async query(sql,args){
  if(sql.startsWith('SELECT model_id'))return{rows:[{model_id:'m',provider:'p',name:'model',version:'1'}]};
  if(sql.startsWith('SELECT report'))return{rows:saved.has(args[0])?[{report:saved.get(args[0])}]:[]};
  if(sql.startsWith('INSERT INTO token_ai_requests'))saved.set(args[1],JSON.parse(args[3]));
  if(sql.includes('INSERT INTO ai_cost_ledger'))failed=args.includes('failed');
  return{rows:[]};
 }})};
 const gateway={chatCompletion:async request=>{calls++;supplied=JSON.parse(request.messages[1].content);return{content:JSON.stringify(answer),traceId:'11111111-1111-4111-8111-111111111111',providerId:'p',inputTokens:10,outputTokens:10,estimatedCostUsd:0}}};
 return{options:{destination,sources:{x,tg:{query:async()=>({rows:[]})},chain:{prepare:()=>({all:()=>[]})}},gateway,modelId:'m',tokenId:'solana:'+mint},parent,state:()=>({supplied,calls,failed,saved})};
}
const contextualAnswer={messageViews:[{evidenceRef:'x:tweet:1',target:'token',stance:'unknown',reading:'negated',contextRefs:['x:tweet:2'],contextUse:'used'}],caveats:[],stance:'mixed',score:0,directionAmbiguous:true,confidence:0.7,factIds:['x.sampledMessages','tg.sampledMessages'],evidenceRefs:['x:tweet:1']};

test('causal-denial uncertainty and complete parent provenance survive save and cached replay',async()=>{
 const f=contextualRequestFixture(contextualAnswer),report=await analyzeTokenOnDemand(f.options);
 const first=f.state();assert.equal(first.supplied.messages[0].context[0].text,f.parent);
 assert.equal(first.supplied.messages[0].context[0].relation,'reply_parent');
 assert.deepEqual(report.interpretation.messageViews,contextualAnswer.messageViews);
 assert.equal(report.interpretation.stance,'mixed');assert.equal(report.interpretation.score,0);
 const stored=[...first.saved.values()][0];assert.deepEqual(stored.interpretation.messageViews,contextualAnswer.messageViews);
 assert.equal(stored.evidence[0].contextEvidence[0].evidenceRef,'x:tweet:2');
 const replay=await analyzeTokenOnDemand(f.options);assert.equal(replay.cached,true);assert.equal(f.state().calls,1);
});

test('context citation promoted into top-level evidence fails closed without save or automatic retry',async()=>{
 const f=contextualRequestFixture({...contextualAnswer,evidenceRefs:['x:tweet:1','x:tweet:2']});
 await assert.rejects(analyzeTokenOnDemand(f.options),/token_ai_evidence_invalid/);
 assert.equal(f.state().calls,1);assert.equal(f.state().failed,true);assert.equal(f.state().saved.size,0);
});

test('numeric fact positions are rejected and billed as a failed attempt, never repaired into facts',async()=>{
 const f=contextualRequestFixture({...contextualAnswer,factIds:[0,1]});
 await assert.rejects(analyzeTokenOnDemand(f.options),/token_ai_facts_invalid/);
 assert.equal(f.state().calls,1);assert.equal(f.state().failed,true);assert.equal(f.state().saved.size,0);
});

test('an open purchase prerequisite stays conditional and retains its complete qualification through persistence',async()=>{
 const text='I bought a small amount. '+mint+' Do not add more before trying the application; only decide after evaluating it.';
 const quote='Do not add more before trying the application; only decide after evaluating it.';
 const answer={...contextualAnswer,messageViews:[{evidenceRef:'x:tweet:1',target:'token',stance:'unknown',reading:'conditional',contextRefs:[],contextUse:'not_needed'}],caveats:[{evidenceRef:'x:tweet:1',quote}]};
 const f=contextualRequestFixture(answer,text),report=await analyzeTokenOnDemand(f.options);
 assert.equal(report.interpretation.stance,'mixed');assert.equal(report.interpretation.score,0);
 assert.equal(report.interpretation.messageViews[0].reading,'conditional');
 const saved=[...f.state().saved.values()][0];assert.equal(saved.interpretation.caveats[0].quote,quote);
 assert.equal(saved.interpretation.caveats[0].contextQuote,text);assert.equal(saved.interpretation.caveats[0].contextComplete,true);
});
