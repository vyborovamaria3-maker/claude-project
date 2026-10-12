import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const {tickSources,resumeSource}=createRequire(__filename)('../scripts/list-core.cjs');

test('list pages survive restart, advance without gaps, preserve watermark on failure and resume',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`CREATE TABLE x_tasks(id bigserial PRIMARY KEY,kind text,payload_json jsonb,priority int,available_at bigint,created_at bigint,updated_at bigint,max_attempts int,status text DEFAULT 'pending');
   CREATE TABLE x_task_tweets(task_id bigint,tweet_id text,PRIMARY KEY(task_id,tweet_id));
   CREATE TABLE x_task_progress(task_id bigint PRIMARY KEY,found int);
   CREATE TABLE xc_auto_sources(list_id text PRIMARY KEY,enabled boolean,interval_minutes int,next_run bigint,last_task_id bigint);
   INSERT INTO xc_auto_sources VALUES('123',true,15,0,NULL);`);
  await db.exec(await fs.readFile('migrations/039_list_checkpoints.sql','utf8'));
  const c={query:async(sql:string,args:unknown[]=[])=>{const r=await db.query(sql,args);return {rows:r.rows,rowCount:r.affectedRows||r.rows.length};}};
  await tickSources(c,1000);await tickSources(c,1001);
  assert.equal((await db.query('SELECT id FROM x_tasks')).rows.length,1);
  const first=(await db.query<{id:string;payload_json:{query:string}}> ('SELECT id,payload_json FROM x_tasks')).rows[0];
  assert.equal(first.payload_json.query,'list:123 since_id:0');
  await db.query("UPDATE x_tasks SET status='done' WHERE id=$1",[first.id]);
  await db.query('INSERT INTO x_task_tweets SELECT $1,(1000000000000000+n)::text FROM generate_series(1,100) n',[first.id]);
  await db.query('INSERT INTO x_task_progress VALUES($1,100)',[first.id]);
  await tickSources(c,2000);
  const second=(await db.query<{id:string;payload_json:{query:string};priority:number}>('SELECT * FROM x_tasks ORDER BY id DESC LIMIT 1')).rows[0];
  assert.equal(second.payload_json.query,'list:123 since_id:0 max_id:1000000000000000');
  assert.equal(second.priority,1);
  await tickSources(c,2001);assert.equal((await db.query('SELECT id FROM x_tasks')).rows.length,2);
  await db.query("UPDATE x_tasks SET status='failed' WHERE id=$1",[second.id]);
  await tickSources(c,3000);
  const partial=(await db.query<{status:string;last_seen_id:string;cursor_id:string}>('SELECT * FROM xc_list_checkpoints')).rows[0];
  assert.equal(partial.status,'partial');assert.equal(partial.last_seen_id,'');assert.equal(partial.cursor_id,'1000000000000000');
  await tickSources(c,9999999);assert.equal((await db.query('SELECT id FROM x_tasks')).rows.length,2);
  await resumeSource(c,'123');await tickSources(c,4000);
  const third=(await db.query<{id:string;payload_json:{query:string}}>('SELECT * FROM x_tasks ORDER BY id DESC LIMIT 1')).rows[0];
  assert.equal(third.payload_json.query,second.payload_json.query);
  await db.query("UPDATE x_tasks SET status='done' WHERE id=$1",[third.id]);
  await db.query('INSERT INTO x_task_progress VALUES($1,1)',[third.id]);
  await db.query("INSERT INTO x_task_tweets VALUES($1,'999999999999999')",[third.id]);
  await tickSources(c,5000);
  const done=(await db.query<{status:string;last_seen_id:string;cursor_id:string}>('SELECT * FROM xc_list_checkpoints')).rows[0];
  assert.equal(done.status,'idle');assert.equal(done.last_seen_id,'1000000000000100');assert.equal(done.cursor_id,'');
  await tickSources(c,10000000);
  const fresh=(await db.query<{payload_json:{query:string}}> ('SELECT * FROM x_tasks ORDER BY id DESC LIMIT 1')).rows[0];
  assert.equal(fresh.payload_json.query,'list:123 since_id:1000000000000100');
 }finally{await db.close();}
});
