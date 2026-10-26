import test from 'node:test';import assert from 'node:assert/strict';
import{validateTokenInterpretation,TOKEN_ANALYSIS_PROMPT}from'../scripts/token-analysis.mjs';
const ref='tg:message:123:2',text='Мне нравится идея, но минусы: низкая мс. I do not think this is safe.';
const input={facts:{'tg.sampledMessages':1},messages:[{evidenceRef:ref,text,context:[{evidenceRef:'tg:message:123:1',text:'a different token is risky'}]}],trades:[]};
const value={stance:'bullish',score:0.4,confidence:0.7,directionAmbiguous:false,factIds:['tg.sampledMessages'],evidenceRefs:[ref],caveats:[{evidenceRef:ref,quote:'минусы: низкая мс'}]};
test('positive stance preserves a source-backed qualification without treating low cap as a price forecast',()=>{
 assert.deepEqual(validateTokenInterpretation(value,input).caveats,value.caveats);assert.equal(validateTokenInterpretation(value,input).stance,'bullish');
 const negated={...value,caveats:[{evidenceRef:ref,quote:'I do not think this is safe.'}]};assert.deepEqual(validateTokenInterpretation(negated,input).caveats,negated.caveats);
 assert.match(TOKEN_ANALYSIS_PROMPT,/Do not strip negation/);assert.match(TOKEN_ANALYSIS_PROMPT,/Low market cap alone is not evidence of falling price/);
});
test('invented, context-only, uncited and malformed caveats fail before persistence',()=>{
 for(const caveats of [null,{},[{evidenceRef:ref,quote:'guaranteed loss'}],[{evidenceRef:'tg:message:123:1',quote:'a different token is risky'}],[{evidenceRef:ref,quote:'  '}],[{evidenceRef:ref,quote:'x'.repeat(241)}],[{evidenceRef:ref,quote:'низкая мс',secret:'hidden'}],Array(5).fill(value.caveats[0]),[...value.caveats,...value.caveats]])assert.throws(()=>validateTokenInterpretation({...value,caveats},input),/caveats_invalid/);
 assert.throws(()=>validateTokenInterpretation({...value,evidenceRefs:[]},input),/caveats_invalid/);
});
