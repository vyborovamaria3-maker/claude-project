import test from 'node:test';import assert from 'node:assert/strict';
import{validateTokenInterpretation,TOKEN_ANALYSIS_PROMPT,caveatContext}from'../scripts/token-analysis.mjs';
const ref='tg:message:123:2',text='Мне нравится идея, но минусы: низкая мс. I do not think this is safe.';
const input={facts:{'tg.sampledMessages':1},messages:[{evidenceRef:ref,text,context:[{evidenceRef:'tg:message:123:1',text:'a different token is risky'}]}],trades:[]};
const value={stance:'bullish',score:0.4,confidence:0.7,directionAmbiguous:false,factIds:['tg.sampledMessages'],evidenceRefs:[ref],caveats:[{evidenceRef:ref,quote:'минусы: низкая мс'}]};
test('positive stance preserves a source-backed qualification without treating low cap as a price forecast',()=>{
 assert.deepEqual(validateTokenInterpretation(value,input).caveats,[{...value.caveats[0],contextQuote:text,contextComplete:true}]);assert.equal(validateTokenInterpretation(value,input).stance,'bullish');
 const negated={...value,caveats:[{evidenceRef:ref,quote:'I do not think this is safe.'}]};assert.equal(validateTokenInterpretation(negated,input).caveats[0].contextQuote,text);
 assert.match(TOKEN_ANALYSIS_PROMPT,/Do not strip negation/);assert.match(TOKEN_ANALYSIS_PROMPT,/Low market cap alone is not evidence of falling price/);
});
test('substring quotes retain negation, contrast and sarcasm in server-derived context',()=>{
 for(const text of ['This is not safe. I would never buy it.','Yeah right, "safe". The deployer dumped again.','People call it a scam, but I do not think it is a scam.']){
  const quote=text.includes('safe')?'safe':'scam';const grounded=validateTokenInterpretation({...value,caveats:[{evidenceRef:ref,quote}]},{...input,messages:[{evidenceRef:ref,text}]});
  assert.equal(grounded.caveats[0].contextQuote,text);assert.equal(grounded.caveats[0].contextComplete,true);
 }
});
test('long-message context has paragraph boundaries, discloses incompleteness and rejects ambiguous locations',()=>{
 const text='intro '.repeat(300)+'\n\nOther token is dangerous.\n\nThis token is not a scam.\n\nI still like it.\n\n'+'tail '.repeat(300);
 const c=caveatContext(text,'not a scam');assert.equal(c.contextComplete,false);assert.match(c.contextQuote,/This token is not a scam/);assert.ok(c.contextQuote.length<=1600);
 assert.throws(()=>caveatContext(text+'not a scam','not a scam'),/context_ambiguous/);
 assert.throws(()=>caveatContext('x'.repeat(1700)+' not safe','safe'),/context_too_large/);
});
test('invented, context-only, uncited and malformed caveats fail before persistence',()=>{
 for(const caveats of [null,{},[{evidenceRef:ref,quote:'guaranteed loss'}],[{evidenceRef:'tg:message:123:1',quote:'a different token is risky'}],[{evidenceRef:ref,quote:'  '}],[{evidenceRef:ref,quote:'x'.repeat(241)}],[{evidenceRef:ref,quote:'низкая мс',secret:'hidden'}],Array(5).fill(value.caveats[0]),[...value.caveats,...value.caveats]])assert.throws(()=>validateTokenInterpretation({...value,caveats},input),/caveats_invalid/);
 assert.throws(()=>validateTokenInterpretation({...value,evidenceRefs:[]},input),/caveats_invalid/);
});
