import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {filterHistory,persistHistory} from '../lib/trade/history-filter';
import {Pool} from 'pg';
import {closePool} from '../lib/trade/pg';
import type {RawTweet} from '../lib/trade/twitter-scraper';
const core=createRequire(__filename)('../scripts/history-core.cjs');

test('list membership discovery captures valid current handles and releases the selected account',async()=>{
 const load=createRequire(__filename),helper=load('../scripts/test-publish-browser.cjs'),runtime=load('../scripts/autopost/runtime.cjs');
 const handles:string[]=[];let released=false,closed=false;
 const page={goto:async()=>({status:()=>200}),url:()=> 'https://x.com/i/lists/123/members',waitForSelector:async()=>{},mouse:{wheel:async()=>{}},waitForTimeout:async()=>{},locator:()=>({evaluateAll:async(fn:(cells:unknown[])=>string[])=>fn([{querySelectorAll:()=>['/Alice','/Bob','/Alice/status/1','/i/lists/123'].map(h=>({getAttribute:()=>h}))}])})};
 const browser={newContext:async()=>({newPage:async()=>page}),close:async()=>{closed=true;}};
 const a=mock.method(helper,'launchLoginBrowser',async()=>({browser}));const b=mock.method(runtime,'unseal',()=>JSON.stringify({cookies:[],origins:[]}));
 const modulePath=load.resolve('../scripts/history-collector.cjs');delete load.cache[modulePath];
 try{
  const {members}=load(modulePath);
  const c={query:async(sql:string,args:unknown[])=>{if(sql.startsWith('INSERT INTO xc_history_authors'))handles.push(String(args[2]));return {rows:[],rowCount:1};}};
  const accounts={pickAccount:async(_kind:string,_owner:string,name:string)=>{assert.equal(name,'collector');return {name,session_encrypted:Buffer.from('fixture'),proxy_json:null};},extendAccountLease:async()=>true,recordSuccess:async()=>{},recordError:async()=>{throw Error('Unexpected error');},releaseAccount:async()=>{released=true;}};
  assert.equal(await members(c,{id:'run',account_name:'collector'},{list_id:'123'},accounts),true);
  assert.deepEqual([...new Set(handles)],['alice','bob']);assert.equal(released,true);assert.equal(closed,true);
 }finally{a.mock.restore();b.mock.restore();delete load.cache[modulePath];}
});

test('two-year history covers every date without gaps, including partial months',()=>{
 const windows=core.monthWindows('2024-10-10','2026-10-11');
 assert.equal(windows.length,25);assert.equal(windows[0].since,'2024-10-10');assert.equal(windows.at(-1).until,'2026-10-11');
 for(let i=1;i<windows.length;i++)assert.equal(windows[i].since,windows[i-1].until);
 assert.throws(()=>core.monthWindows('2026-10-10','2024-10-10'));
});

test('history rejects dates, authors and cursor IDs outside the requested archive slice',()=>{
 const base={id:'1000000000000001',authorHandle:'alice',postedAt:Date.parse('2024-10-11T00:00:00Z')} as RawTweet;
 const rows=[base,{...base,postedAt:Date.parse('2024-11-01T00:00:00Z')},{...base,postedAt:null},{...base,authorHandle:'bob'},{...base,id:'1000000000000003'}];
 assert.deepEqual(filterHistory(rows,{history_since:'2024-10-10',history_until:'2024-11-01',history_author:'Alice',history_max_id:'1000000000000002'}),[base]);
});

test('history jobs persist, deduplicate starts and paginate a full period without losing task attribution',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`CREATE TABLE x_accounts(name text PRIMARY KEY,role text,status text);
   CREATE TABLE x_tasks(id bigserial PRIMARY KEY,kind text,payload_json jsonb,priority int,available_at bigint,created_at bigint,updated_at bigint,max_attempts int,status text DEFAULT 'pending');
   CREATE TABLE x_task_progress(task_id bigint PRIMARY KEY,found int);
   CREATE TABLE x_task_tweets(task_id bigint,tweet_id text,PRIMARY KEY(task_id,tweet_id));
   INSERT INTO x_accounts VALUES('collector','collector','active'),('publisher','publisher','active');`);
  await db.exec(await fs.readFile('migrations/021_history_collection.sql','utf8'));
  const c={query:async(sql:string,params:unknown[]=[])=>{const r=await db.query(sql,params);return {rows:r.rows,rowCount:r.rows.length||r.affectedRows};}};
  const id=await core.startRun(c,'collector','2024-10-10','2026-10-11',['123']);
  assert.equal(await core.startRun(c,'collector','2024-10-10','2026-10-11',['123']),id);
  await assert.rejects(core.startRun(c,'publisher','2024-10-10','2026-10-11',['123']),/Collector/);
  const run=(await db.query('SELECT * FROM xc_history_runs WHERE id=$1',[id])).rows[0];
  await core.addWindows(c,run,'from:alice','alice');await core.addWindows(c,run,'from:alice','alice');
  assert.equal(Number((await db.query<{count:string}>('SELECT count(*) FROM xc_history_windows')).rows[0].count),150);
  await core.queueWindows(c,run);await core.queueWindows(c,run);
  const tasks=(await db.query<{id:string;payload_json:{account_name:string;history_author:string;query:string}}>('SELECT * FROM x_tasks ORDER BY id')).rows;
  assert.equal(tasks.length,2);assert.equal(tasks[0].payload_json.account_name,'collector');assert.equal(tasks[0].payload_json.history_author,'alice');
  await db.query("UPDATE x_tasks SET status='done'");
  await db.query('INSERT INTO x_task_progress VALUES($1,100),($2,0)',[tasks[0].id,tasks[1].id]);
  await db.query("INSERT INTO x_task_tweets SELECT $1,(1000000000000000+v)::text FROM generate_series(0,99) v",[tasks[0].id]);
  await core.advanceWindows(c,run);
  const continued=(await db.query<{status:string;cursor_id:string}>('SELECT status,cursor_id FROM xc_history_windows WHERE cursor_id!=\'\'')).rows[0];
  assert.deepEqual(continued,{status:'pending',cursor_id:'999999999999999'});
  await core.queueWindows(c,run);
  assert.equal(Number((await db.query<{count:string}>('SELECT count(*) FROM xc_history_tasks')).rows[0].count),4);
  assert.equal(Number((await db.query<{count:string}>('SELECT count(*) FROM x_task_tweets')).rows[0].count),100);
  assert.match((await db.query<{query:string}>("SELECT payload_json->>'query' AS query FROM x_tasks WHERE payload_json ? 'history_max_id'")).rows[0].query,/max_id:999999999999999/);
  await db.exec(await fs.readFile('migrations/022_history_archive.sql','utf8'));
  await db.exec("CREATE TABLE twitter_tweets(tweet_id text PRIMARY KEY,text text,posted_at bigint); INSERT INTO twitter_tweets VALUES('1000000000000000','Durable historical fixture',1728518400000)");
  const poolQuery=mock.method(Pool.prototype,'query',c.query);
  try{await persistHistory(id,Number(tasks[0].id));}finally{await closePool();poolQuery.mock.restore();}
  await db.query('DELETE FROM x_tasks WHERE id=$1',[tasks[0].id]);await db.exec('DELETE FROM twitter_tweets');
  assert.equal((await db.query<{text:string}>("SELECT snapshot_json->>'text' AS text FROM xc_history_posts WHERE run_id=$1",[id])).rows[0].text,'Durable historical fixture');
 }finally{await db.close();}
});
