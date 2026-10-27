import test from'node:test';import assert from'node:assert/strict';import{validateTokenInterpretation,analyzeTokenOnDemand}from'../scripts/token-analysis.mjs';
const messages=[{evidenceRef:'x:tweet:1',text:'Excellent security: the team emptied the pool again.',context:[]},{evidenceRef:'tg:message:123:2',text:'I expect growth.',context:[{evidenceRef:'tg:message:123:1',text:'Earlier context',relation:'reply_parent'}]}];
const input={facts:{'x.sampledMessages':1,'tg.sampledMessages':1},messages,trades:[]};
const view=(evidenceRef,stance,reading='literal',target='token',contextRefs=[])=>({evidenceRef,stance,reading,target,contextRefs});
const value={stance:'bullish',score:0.7,directionAmbiguous:false,confidence:0.8,factIds:['x.sampledMessages','tg.sampledMessages'],evidenceRefs:messages.map(m=>m.evidenceRef),caveats:[]};
test('AI message-level ironic criticism survives positive aggregate without any keyword guard',()=>{
 const result=validateTokenInterpretation({...value,messageViews:[view('x:tweet:1','bearish','ironic'),view('tg:message:123:2','bullish')]},input);
 assert.equal(result.stance,'mixed');assert.equal(result.score,0);assert.equal(result.aggregationMethod,'message_views');assert.equal(result.messageViews[0].reading,'ironic');assert.equal(result.directionGuardApplied,undefined);
 // A keyword in the text cannot independently rewrite a classification.
 assert.equal(validateTokenInterpretation(value,{...input,messages:[{...messages[0],text:'This token is a serial rugger.'},messages[1]]}).stance,'bullish');
});
test('new requests reject legacy aggregate-only output, record the failed attempt and never retry',async()=>{
 const mint='So11111111111111111111111111111111111111112';let calls=0,failed=false,released=false;
 const destination={connect:async()=>({release(){released=true;},async query(sql,args){
  if(sql.startsWith('SELECT model_id'))return {rows:[{model_id:'test',provider:'p',name:'m',version:'1'}]};
  if(sql.includes('INSERT INTO ai_cost_ledger'))failed=args.includes('failed');return {rows:[]};
 }})};
 const sources={x:{query:async()=>({rows:[{tweet_id:'1',text:'This token is a serial rugger. '+mint,updated_at:Date.now()-1000}]})},tg:{query:async()=>({rows:[]})},chain:{prepare:()=>({all:()=>[]})}};
 const gateway={chatCompletion:async()=>{calls++;return {content:JSON.stringify(value),traceId:'11111111-1111-4111-8111-111111111111',providerId:'p',inputTokens:1,outputTokens:1,estimatedCostUsd:0.001};}};
 await assert.rejects(analyzeTokenOnDemand({destination,sources,gateway,modelId:'test',tokenId:'solana:'+mint}),/message_views_required/);
 assert.equal(calls,1);assert.equal(failed,true);assert.equal(released,true);
});
test('denials and other-target negativity do not reverse consistent AI token views',()=>{
 const result=validateTokenInterpretation({...value,messageViews:[view('x:tweet:1','neutral','negated','other'),view('tg:message:123:2','bullish','negated','token',['tg:message:123:1'])]},input);
 assert.equal(result.stance,'bullish');assert.equal(result.score,0.7);assert.deepEqual(result.messageViews[1].contextRefs,['tg:message:123:1']);
});
test('unknown parent or unresolved target cannot become a current directional result',()=>{
 const result=validateTokenInterpretation({...value,messageViews:[view('x:tweet:1','unknown','unclear','unclear'),view('tg:message:123:2','bullish')]},input);assert.equal(result.stance,'mixed');assert.equal(result.score,0);
 const other=validateTokenInterpretation({...value,messageViews:messages.map(m=>view(m.evidenceRef,'neutral','literal','other'))},input);assert.equal(other.stance,'unknown');assert.equal(other.score,0);
});
test('views must cover every source message once and use only that message supplied context',()=>{
 const good=[view('x:tweet:1','bearish','ironic'),view('tg:message:123:2','bullish')];
 for(const messageViews of [[],[good[0]],[good[0],good[0]],[good[0],{...good[1],evidenceRef:'x:tweet:99'}],[{...good[0],contextRefs:['tg:message:123:1']},good[1]],[{...good[0],reading:'unclear'},good[1]],[{...good[0],privateField:'hidden'},good[1]]])assert.throws(()=>validateTokenInterpretation({...value,messageViews},input),/message_views_invalid/);
 assert.throws(()=>validateTokenInterpretation({...value,messageViews:messages.map(m=>view(m.evidenceRef,'bearish'))},input),/views_direction_inconsistent/);
});
