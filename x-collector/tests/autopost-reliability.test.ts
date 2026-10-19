import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';

const load=createRequire(__filename);
const retry=load('../scripts/autopost/publish-retry.cjs');

test('temporary network failures are retryable only before the send boundary',()=>{
 const error=new Error('page.goto: net::ERR_CONNECTION_RESET at https://x.com/home');
 assert.equal(retry.classifyPreSendError(error).code,'TEMPORARY_NETWORK');
 assert.equal(retry.shouldRetryBeforeSend(error,false,0),true);
 assert.equal(retry.shouldRetryBeforeSend(error,true,0),false);
 assert.equal(retry.shouldRetryBeforeSend(error,false,retry.MAX_PRE_SEND_RETRIES),false);
});

test('expired sessions, proxy errors and platform restrictions require intervention',()=>{
 assert.equal(retry.classifyPreSendError(new Error('SESSION_EXPIRED')).code,'SESSION_EXPIRED');
 assert.equal(retry.classifyPreSendError(new Error('PROXY_FAILED')).code,'PROXY_FAILED');
 assert.equal(retry.classifyPreSendError(new Error('HTTP 429 rate limit')).code,'X_RESTRICTED');
 assert.equal(retry.classifyPreSendError(new Error('Профиль сессии не совпал с username')).code,'ACCOUNT_MISMATCH');
 assert.equal(retry.classifyPreSendError(new Error('Задание остановлено до отправки')).code,'JOB_NOT_ELIGIBLE');
 assert.equal(retry.classifyPreSendError(new Error('TARGET_NOT_FOUND')).code,'TARGET_NOT_FOUND');
 assert.equal(retry.shouldRetryBeforeSend(new Error('SESSION_EXPIRED'),false,0),false);
});

test('retry delays grow and remain bounded',()=>{
 assert.equal(retry.retryDelayMs(0),30_000);
 assert.equal(retry.retryDelayMs(1),120_000);
 assert.equal(retry.retryDelayMs(2),600_000);
 assert.equal(retry.retryDelayMs(3),600_000);
});

test('post deduplication ignores source tweet ids and their permalinks',async()=>{
 const storePath=load.resolve('../scripts/autopost/store.cjs');
 delete load.cache[storePath];
 const {enqueue}=load(storePath);
 const inserts:unknown[][]=[];
 const c={query:async(sql:string,values:unknown[]=[] )=>{
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {rows:[]};
  if(sql.includes('AND (content_hash=$3 OR dedup=$4) AND attempted'))return {rows:[]};
  if(sql.includes('AND (content_hash=dedup OR content_hash IS NULL)'))return {rows:[]};
  if(sql.startsWith('SELECT name FROM x_accounts'))return {rows:[{name:'publisher'}]};
  if(sql.startsWith('INSERT INTO xc_auto_jobs')){inserts.push(values);return {rows:[]};}
  if(sql.startsWith('SELECT * FROM xc_auto_jobs WHERE id=$1 OR dedup=$2'))return {rows:[{id:values[0],dedup:values[1],created_at:Date.now()}]};
  throw new Error('Unexpected SQL in test: '+sql);
 }};
 try{
  await enqueue(c,{id:'00000000-0000-4000-8000-000000000001',name:'publisher',expected:'publisher',kind:'post',text:'Read the research first. https://x.com/i/status/123',target_id:'123'});
  await enqueue(c,{id:'00000000-0000-4000-8000-000000000002',name:'publisher',expected:'publisher',kind:'post',text:'Read the research first. https://x.com/i/status/456',target_id:'456'});
  assert.equal(inserts.length,2);
  assert.notEqual(inserts[0][5],inserts[1][5]);
  assert.equal(inserts[0][10],inserts[1][10]);
 }finally{delete load.cache[storePath];}
});

test('CreateTweet 403/429 is classified as account restriction, without retrying uncertain sends',()=>{
 const {confirmedCreateTweetResponse}=load('../scripts/autopost/browser.cjs');
 for(const status of [403,429]){
  let caught:unknown;
  try{confirmedCreateTweetResponse({ok:false,status,body:{errors:[{message:'private response'}]}});}catch(error){caught=error;}
  assert.equal(retry.classifyPreSendError(caught).code,'X_RESTRICTED');
  assert.equal(retry.shouldRetryBeforeSend(caught,true,0),false);
 }
 assert.throws(()=>confirmedCreateTweetResponse({ok:false,status:401,body:null}),/SESSION_EXPIRED/);
 const id=confirmedCreateTweetResponse({ok:true,status:200,body:{data:{create_tweet:{tweet_results:{result:{rest_id:'123456'}}}}}});
 assert.equal(id,'123456');
});
