import test from'node:test';import assert from'node:assert/strict';import{validateTokenInterpretation,tokenAnalysisFingerprint}from'../scripts/token-analysis.mjs';
const ref='x:tweet:1',parent='x:tweet:2',input={facts:{'x.sampledMessages':1,'tg.sampledMessages':0},messages:[{evidenceRef:ref,text:'Our unnamed asset was stolen, but relax: the network benchmark improved.',context:[]}],trades:[]};
const output=view=>({messageViews:[{evidenceRef:ref,contextRefs:[],contextUse:'not_needed',...view}],caveats:[],stance:'mixed',score:0,directionAmbiguous:true,confidence:0.7,factIds:['x.sampledMessages','tg.sampledMessages'],evidenceRefs:[ref]});
test('unattributed irony remains visible without inventing direction for the requested asset',()=>{
 const result=validateTokenInterpretation(output({target:'unclear',stance:'unknown',reading:'ironic'}),input);
 assert.equal(result.messageViews[0].reading,'ironic');assert.equal(result.messageViews[0].stance,'unknown');assert.equal(result.stance,'mixed');assert.equal(result.score,0);
 assert.throws(()=>validateTokenInterpretation(output({target:'unclear',stance:'bearish',reading:'ironic'}),input),/message_views_invalid/);
});
test('a genuine contextual reply preserves literal reading and cannot cite someone else’s parent',()=>{
 const contextual={...input,messages:[{evidenceRef:ref,text:'That is disappointing. We can pause and study instead.',context:[{evidenceRef:parent,text:'Recent attempts have mostly lost.',relation:'reply_parent'}]}]};
 const value=output({target:'other',stance:'neutral',reading:'literal',contextRefs:[parent],contextUse:'used'}),result=validateTokenInterpretation(value,contextual);
 assert.equal(result.messageViews[0].reading,'literal');assert.equal(result.stance,'unknown');assert.deepEqual(result.messageViews[0].contextRefs,[parent]);
 assert.throws(()=>validateTokenInterpretation(output({...value.messageViews[0],contextRefs:['x:tweet:3']}),contextual),/message_views_invalid/);
 assert.notEqual(tokenAnalysisFingerprint('m',input),tokenAnalysisFingerprint('m',contextual));
});
