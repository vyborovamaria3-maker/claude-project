import test from 'node:test';
import assert from 'node:assert/strict';
import {collectTokenInputs,analyzeTokenOnDemand} from '../scripts/token-analysis.mjs';

const mint='So11111111111111111111111111111111111111112',tokenId='solana:'+mint;
function sources(texts){
 return {x:{connect:async()=>({query:async()=>({rows:[]}),release(){}}),query:async()=>({rows:texts.map((text,index)=>({tweet_id:String(index+1),text,updated_at:Date.now()-1000}))})},
  tg:{query:async()=>({rows:[]})},chain:{prepare:()=>({all:()=>[]})}};
}
function textOfLength(length,index=0){
 const start=`Quoted claim ${index}: ${mint} `;
 return start+'x'.repeat(length-start.length);
}
test('Twitter context counts toward the shared text budget before any provider access',async()=>{
 const texts=[textOfLength(5000,1),textOfLength(5000,2),textOfLength(5000,3)],source=sources(texts),posted=Date.now()-1000;
 source.x.connect=async()=>({release(){},async query(sql,args){
  if(sql.includes('to_regclass'))return {rows:[{observations:'twitter_tweet_observations'}]};
  if(sql.startsWith('SELECT o.raw'))return {rows:[{raw:{id:args[0],replyToPostId:'999'},posted_at:posted}]};
  if(sql.startsWith('SELECT raw,observed_at'))return {rows:[{raw:{id:'999',text:'c'.repeat(1200),postedAt:posted-1000},observed_at:new Date(posted)}]};
  return {rows:[]};
 }});
 await assert.rejects(analyzeTokenOnDemand({sources:source,tokenId,modelId:'unused',destination:{connect(){assert.fail('must not connect destination')}},gateway:{chatCompletion(){assert.fail('must not call provider')}}}),/token_ai_input_too_large/);
});
async function rejectsBeforeProvider(texts){
 let connected=false,called=false;
 await assert.rejects(analyzeTokenOnDemand({sources:sources(texts),tokenId,modelId:'unused',
  destination:{connect:async()=>{connected=true;assert.fail('oversized input must fail before destination access');}},
  gateway:{chatCompletion:async()=>{called=true;assert.fail('oversized input must not call provider');}}}),
  error=>error instanceof Error&&error.message==='token_ai_input_too_large');
 assert.equal(connected,false);assert.equal(called,false);
}

test('token analysis preserves full selected text including a denial after character 1600',async()=>{
 const denial='\nActually I would never buy; all the above is false.';
 const text=textOfLength(2084-denial.length)+denial;
 const input=await collectTokenInputs(sources([text]),tokenId);
 assert.equal(text.length,2084);assert.equal(input.messages[0].text,text);
 assert.ok(input.messages[0].text.endsWith(denial));
});
test('token analysis rejects selected messages above 6000 characters before provider access',async()=>{
 await rejectsBeforeProvider([textOfLength(6001)]);
 const input=await collectTokenInputs(sources([textOfLength(6000)]),tokenId);
 assert.equal(input.messages[0].text.length,6000);
});
test('token analysis rejects a selected text budget above 16000 characters before provider access',async()=>{
 await rejectsBeforeProvider([textOfLength(6000,1),textOfLength(6000,2),textOfLength(4001,3)]);
 const input=await collectTokenInputs(sources([textOfLength(6000,1),textOfLength(6000,2),textOfLength(4000,3)]),tokenId);
 assert.equal(input.messages.reduce((sum,message)=>sum+message.text.length,0),16000);
});
