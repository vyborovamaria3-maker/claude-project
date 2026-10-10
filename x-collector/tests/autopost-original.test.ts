import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test,mock} from 'node:test';
const load=createRequire(__filename);
const providers=load('../scripts/autopost/providers.cjs');
const modulePath=load.resolve('../scripts/autopost/store.cjs');

test('empty source cycles enqueue only an original post without fabricated targets or evidence',async()=>{
 const generate=mock.method(providers,'generate',async()=>JSON.stringify({actions:[{kind:'post',source_id:'original',text:'What do you check before joining a new community?',reason:'Original discussion'}]}));
 delete load.cache[modulePath];const {planOriginal}=load(modulePath);
 let inserted:unknown[]=[];let message='';const now=Date.now();
 const c={query:async(sql:string,values:unknown[])=>{
  if(sql.startsWith('SELECT * FROM xc_ai_providers'))return {rows:[{id:'provider'}]};
  if(sql.startsWith('SELECT content'))return {rows:[]};
  if(sql.startsWith('SELECT name'))return {rows:[{name:'publisher'}]};
  if(sql.startsWith('INSERT INTO xc_auto_jobs')){inserted=values;return {rows:[]};}
  if(sql.startsWith('SELECT * FROM xc_auto_jobs'))return {rows:[{created_at:now}]};
  if(sql.startsWith('UPDATE xc_auto_config')){message=String(values[1]);return {rows:[]};}
  throw Error('Unexpected SQL');
 }};
 try{
  await planOriginal(c,{account_name:'publisher',expected_handle:'publisher',provider_id:'provider',kinds:['post','like'],language:'en',style:''},now);
  assert.equal(inserted[3],'post');assert.equal(inserted[5],null);assert.equal(inserted[6],null);assert.equal(inserted[7],'[]');assert.equal(inserted[13],'agent');
  assert.match(message,/самостоятельный пост/);
  inserted=[];await planOriginal(c,{account_name:'publisher',kinds:['like','repost']},now);
  assert.equal(inserted.length,0);assert.equal(generate.mock.callCount(),1);assert.match(message,/Нет источников для реакций/);
 }finally{generate.mock.restore();delete load.cache[modulePath];}
});

test('original post generation rejects fabricated reaction targets',async()=>{
 const generate=mock.method(providers,'generate',async()=>JSON.stringify({actions:[{kind:'like',source_id:'123',reason:'Invented target'}]}));
 delete load.cache[modulePath];const {planOriginal}=load(modulePath);
 try{
  const c={query:async(sql:string)=>({rows:sql.includes('xc_ai_providers')?[{}]:[]})};
  await assert.rejects(planOriginal(c,{account_name:'publisher',kinds:['post'],language:'en',style:''},Date.now()),/Неизвестное действие или источник/);
 }finally{generate.mock.restore();delete load.cache[modulePath];}
});
