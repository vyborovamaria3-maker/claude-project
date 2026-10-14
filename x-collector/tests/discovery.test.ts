import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
test('history producer queues two distinct windows when collector policy permits two accounts',async()=>{
 const db=new PGlite();
 try{
  for(const file of REQUIRED)await db.exec(await fs.readFile('migrations/'+file,'utf8'));
  const c={query:async(sql:string,args:unknown[]=[])=>{const r=await db.query(sql,args);return {rows:r.rows,rowCount:r.rows.length||r.affectedRows};}};
  await db.exec(`INSERT INTO xc_history_runs(id,since_date,until_date,topics_json,created_at,updated_at) VALUES('parallel-run','2026-01-01','2026-02-01','[]',0,0);
   UPDATE xc_discovery_plan SET enabled=true,history_run_id='parallel-run',max_browser_accounts=2;
   INSERT INTO xc_history_windows(run_id,base_query,author_handle,since_date,until_date,status) VALUES
   ('parallel-run','from:alice','alice','2026-01-01','2026-02-01','pending'),
   ('parallel-run','from:bob','bob','2026-01-01','2026-02-01','pending');`);
  await queueWindows(c,{id:'parallel-run',account_name:'collector'});
  const rows=(await db.query<{id:number}>('SELECT id FROM x_tasks')).rows;
  assert.equal(rows.length,2);assert.notEqual(rows[0].id,rows[1].id);
  await queueWindows(c,{id:'parallel-run',account_name:'collector'});
  assert.equal((await db.query('SELECT id FROM x_tasks')).rows.length,2);
 }finally{await db.close();}
});
import {REQUIRED} from '../lib/trade/migrations';
const load=createRequire(__filename);
const {tickDiscovery,readiness}=load('../scripts/discovery-core.cjs');
const {queueWindows}=load('../scripts/history-core.cjs');
test('discovery waits for all three list archives, pages durably, blocks on failed archive and preserves failed cursors',async()=>{
 const db=new PGlite();
 try{
  for(const file of REQUIRED)await db.exec(await fs.readFile('migrations/'+file,'utf8'));
  await db.exec('CREATE TABLE xc_auto_sources(list_id text PRIMARY KEY,enabled boolean DEFAULT true,interval_minutes integer DEFAULT 15,next_run bigint DEFAULT 0,last_task_id bigint)');
  const c={query:async(sql:string,args:unknown[]=[])=>{const r=await db.query(sql,args);return {rows:r.rows,rowCount:r.rows.length||r.affectedRows};}};
  await db.exec(`INSERT INTO xc_history_runs(id,since_date,until_date,topics_json,created_at,updated_at) VALUES('run','2026-01-01','2026-02-01','[]',0,0);
   INSERT INTO xc_auto_sources(list_id) VALUES('1'),('2'),('3');
   INSERT INTO xc_list_checkpoints(list_id,last_completed_at) VALUES('1',100),('2',100),('3',100);
   INSERT INTO xc_history_lists(run_id,list_id,status) VALUES('run','1','done'),('run','2','done'),('run','3','done');
   INSERT INTO xc_history_authors VALUES('run','1','alice');
   INSERT INTO xc_history_windows(run_id,base_query,author_handle,since_date,until_date,status) VALUES('run','from:alice','alice','2026-01-01','2026-02-01','pending'),('run','memes',NULL,'2026-01-01','2026-02-01','pending');
   UPDATE xc_discovery_plan SET enabled=true,list_ids='["1","2","3"]',history_run_id='run';
   INSERT INTO xc_discovery_sources(name,query) VALUES('memes','meme');`);
  assert.equal((await tickDiscovery(c,1000)).ready,false);
  // A topic queued before enabling the plan must not occupy the author's queue slot.
  await db.exec("UPDATE xc_history_windows SET status='queued' WHERE author_handle IS NULL");
  await queueWindows(c,{id:'run',account_name:'collector'});
  const tasks=(await db.query<{payload_json:{history_author:string}}> ('SELECT payload_json FROM x_tasks')).rows;
  assert.equal(tasks.length,1);assert.equal(tasks[0].payload_json.history_author,'alice');
  await db.exec("UPDATE x_tasks SET status='done'; UPDATE xc_history_windows SET status='done' WHERE author_handle IS NOT NULL");
  assert.equal((await readiness(c)).ready,true);
  await tickDiscovery(c,2000);await tickDiscovery(c,2001);
  let source=(await db.query<{task_id:string;cursor_id:string;last_seen_id:string;status:string}>('SELECT * FROM xc_discovery_sources')).rows[0];
  assert.equal((await db.query("SELECT 1 FROM x_tasks WHERE payload_json ? 'discovery_source'")).rows.length,1);
  await db.query("UPDATE x_tasks SET status='done' WHERE id=$1",[source.task_id]);
  await db.exec("INSERT INTO twitter_tweets(tweet_id,handle,text,first_seen_at,updated_at) SELECT (1000000000000000+n)::text,'alice','fixture',0,0 FROM generate_series(1,100) n");
  await db.query('INSERT INTO x_task_tweets SELECT $1,(1000000000000000+n)::text FROM generate_series(1,100) n',[source.task_id]);
  await db.query('INSERT INTO x_task_progress(task_id,worker_id,attempt,phase,found,started_at,updated_at) VALUES($1,\'fixture\',1,\'done\',100,0,0)',[source.task_id]);
  await tickDiscovery(c,3000);
  source=(await db.query<typeof source>('SELECT * FROM xc_discovery_sources')).rows[0];
  assert.equal(source.cursor_id,'1000000000000000');assert.equal(source.last_seen_id,'');
  const page=(await db.query<{payload_json:{query:string;discovery_source:string}}> ('SELECT payload_json FROM x_tasks WHERE id=$1',[source.task_id])).rows[0].payload_json;
  assert.equal(page.query,'meme since_id:0 max_id:1000000000000000');
  assert.equal(page.discovery_source,'memes');assert.equal('list_source_id' in page,false);
  await db.query("UPDATE x_tasks SET status='failed' WHERE id=$1",[source.task_id]);
  await tickDiscovery(c,4000);
  source=(await db.query<typeof source>('SELECT * FROM xc_discovery_sources')).rows[0];
  assert.equal(source.status,'partial');assert.equal(source.cursor_id,'1000000000000000');assert.equal(source.last_seen_id,'');
  await db.exec("UPDATE xc_history_windows SET status='failed' WHERE author_handle IS NOT NULL");
  assert.equal((await readiness(c)).ready,false);
  await db.exec("UPDATE xc_history_windows SET status='done' WHERE author_handle IS NOT NULL; UPDATE xc_history_lists SET status='failed' WHERE list_id='3'");
  assert.equal((await readiness(c)).ready,false);
  await db.exec("UPDATE xc_history_lists SET status='done'; UPDATE xc_list_checkpoints SET status='partial' WHERE list_id='3'");
  assert.equal((await readiness(c)).ready,false);
 }finally{await db.close();}
});
