import test from 'node:test';import assert from 'node:assert/strict';import{collectTokenInputs}from'../scripts/token-analysis.mjs';
const mint='So11111111111111111111111111111111111111112';
test('one linked Twitter reply survives latest-post sampling alongside warnings within four messages',async()=>{
 const rows=Array.from({length:10},(_,i)=>({tweet_id:String(i+1),text:'Opinion '+i+' '+mint,updated_at:Date.now()-1000}));rows[7].text='Avoid this scam '+mint;
 const x={query:async()=>({rows}),connect:async()=>({release(){},query:async sql=>({rows:sql.includes('to_regclass')?[{observations:'twitter_tweet_observations'}]:sql.startsWith('SELECT t.tweet_id')?[{tweet_id:'9'}]:[]})})};
 const input=await collectTokenInputs({x,tg:{query:async()=>({rows:[]})},chain:{prepare:()=>({all:()=>[]})}},'solana:'+mint);
 assert.equal(input.messages.length,4);assert.ok(input.messages.some(m=>m.evidenceRef==='x:tweet:8'));assert.ok(input.messages.some(m=>m.evidenceRef==='x:tweet:9'));
});
test('late warning survives bounded sampling without expanding paid message cap',async()=>{
 const rows=Array.from({length:60},(_,i)=>({tweet_id:String(i+1),text:'Positive opinion number '+i+' '+mint,updated_at:Date.now()-1000}));rows[40].text='I feel very uncomfortable; avoid this scam '+mint;
 const input=await collectTokenInputs({x:{connect:async()=>({query:async()=>({rows:[]}),release(){}}),query:async(_sql,args)=>{assert.equal(args[2],97);return{rows};}},tg:{query:async()=>({rows:[]})},chain:{prepare:()=>({all:()=>[]})}},'solana:'+mint);
 assert.equal(input.messages.length,4);assert.equal(input.sourceStatus.x.truncated,true);assert.ok(input.messages.some(m=>m.evidenceRef==='x:tweet:41'));assert.ok(input.messages.some(m=>m.text.startsWith('Positive opinion')));
});
test('late low-cap qualification gets a bounded slot alongside positive posts',async()=>{
 const rows=Array.from({length:60},(_,i)=>({tweet_id:String(i+1),text:'Positive opinion number '+i+' '+mint,updated_at:Date.now()-1000}));rows[40].text='Мне нравится идея, но минусы: низкая мс '+mint;
 const input=await collectTokenInputs({x:{connect:async()=>({query:async()=>({rows:[]}),release(){}}),query:async()=>({rows})},tg:{query:async()=>({rows:[]})},chain:{prepare:()=>({all:()=>[]})}},'solana:'+mint);
 assert.equal(input.messages.length,4);assert.ok(input.messages.some(m=>m.evidenceRef==='x:tweet:41'));
});
