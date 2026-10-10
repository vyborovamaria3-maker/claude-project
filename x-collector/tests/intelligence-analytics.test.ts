import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connectedComponents,pageRank,cosine} from '../lib/trade/intelligence-analytics';
test('observed graph analytics respects disconnected groups and directed influence',()=>{
 const edges=[{source:'a',target:'b',weight:1},{source:'c',target:'b',weight:1},{source:'d',target:'e',weight:1}];
 assert.deepEqual(connectedComponents(edges),[['a','b','c'],['d','e']]);const rank=pageRank(edges);
 assert.ok(rank.get('b')!>rank.get('a')!);assert.ok(Math.abs([...rank.values()].reduce((a,b)=>a+b,0)-1)<1e-9);
 assert.equal(cosine([1,0],[1,0]),1);assert.equal(cosine([1,0],[0,1]),0);assert.throws(()=>cosine([0,0],[1,1]));assert.throws(()=>cosine([1],[1,2]));
});
