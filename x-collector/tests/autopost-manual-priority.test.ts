import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

const load=createRequire(__filename);
const {dueJobs}=load('../scripts/autopost/queue.cjs');

test('manual jobs are selected before LIMIT even after 120 older agent jobs',async()=>{
 const db=new PGlite();
 const now=1_800_000_000_000;
 try{
  await db.exec("CREATE TABLE x_accounts(name text PRIMARY KEY,role text,status text,account_busy_until bigint); CREATE TABLE x_tasks(id bigint PRIMARY KEY)");
  await db.exec(readFileSync('scripts/autopost/schema.sql','utf8'));
  await db.query("INSERT INTO x_accounts(name,role,status,account_busy_until) VALUES ('publisher','publisher','active',0)");
  await db.query("INSERT INTO xc_auto_config(account_name,enabled,expected_handle,start_hour,end_hour,daily_limit,updated_at) VALUES ('publisher',true,'publisher',0,0,100,$1)",[now]);
  await db.query(`INSERT INTO xc_auto_jobs(id,account_name,expected_handle,kind,content,dedup,scheduled_at,created_at,origin)
   SELECT 'agent-'||seq::text,'publisher','publisher','post','agent text','agent-dedup-'||seq::text,$1::bigint-1000+seq,$1::bigint-1000+seq,'agent'
   FROM generate_series(1,120) seq`,[now]);
  await db.query("INSERT INTO xc_auto_jobs(id,account_name,expected_handle,kind,content,dedup,scheduled_at,created_at,origin) VALUES ('manual','publisher','publisher','post','manual text','manual-dedup',$1,$1,'manual')",[now-1]);
  const c={query:(sql:string,args:unknown[])=>db.query(sql,args)};
  const due=await dueJobs(c,now,false,12,now-86400000);
  assert.equal(due.length,20);
  assert.equal(due[0].id,'manual');
  assert.equal(due.slice(1).every((job:{origin:string})=>job.origin==='agent'),true);
  const paused=await dueJobs(c,now,true,12,now-86400000);
  assert.deepEqual(paused.map((job:{id:string})=>job.id),['manual'],'Paused planner must not run agent jobs');
  await db.query("UPDATE x_accounts SET account_busy_until=$1 WHERE name='publisher'",[now+600000]);
  assert.deepEqual(await dueJobs(c,now,false,12,now-86400000),[],'Busy account is ineligible');
  const index=(await db.query<{indexname:string}>("SELECT indexname FROM pg_indexes WHERE tablename='xc_auto_jobs' AND indexname='xc_auto_jobs_manual_due'")).rows;
  assert.equal(index.length,1);
 }finally{await db.close();}
});
