import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {createRequire} from 'node:module';

const load=createRequire(__filename);
const {recoverInterruptedJobs}=load('../scripts/autopost/recovery.cjs');
const {RECONCILIATION_WINDOW_MS}=load('../scripts/autopost/reconciliation.cjs');
const schema=readFileSync('scripts/autopost/schema.sql','utf8');
const now=1_800_000_000_000;

async function fixture(){
 const db=new PGlite();
 await db.exec("CREATE TABLE x_accounts(name text PRIMARY KEY,role text NOT NULL,status text NOT NULL,account_busy_until bigint,publisher_handle text,updated_at bigint NOT NULL DEFAULT 0);CREATE TABLE x_tasks(id bigint PRIMARY KEY)");
 await db.exec("CREATE TABLE twitter_tweets(tweet_id text PRIMARY KEY,handle text,text text,url text,posted_at bigint,first_seen_at bigint,updated_at bigint,source_query text,views bigint,likes bigint,replies bigint,retweets bigint)");
 await db.exec(schema);
 const c={query:async(q:string,params:unknown[]=[] )=>{const r=await db.query(q,params);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length};}};
 return {db,c};
}
async function insertJob(db:PGlite,options:{id:string;status?:string;kind?:string;attempted?:boolean;retryCount?:number;createdAt?:number;attemptedAt?:number|null;startedAt?:number|null;scheduledAt?:number;resultId?:string|null}){
 const {id,status='running',kind='post',attempted=false,retryCount=0,createdAt=now,attemptedAt=null,startedAt=now,scheduledAt=now,resultId=null}=options;
 await db.query("INSERT INTO xc_auto_jobs(id,account_name,expected_handle,kind,content,dedup,status,attempted,retry_count,scheduled_at,created_at,started_at,attempted_at,lease_until,result_id,origin) VALUES($1,'publisher','publisher',$2,'test publication',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual')",[id,kind,'recovery-'+id,status,attempted,retryCount,scheduledAt,createdAt,startedAt,attemptedAt,now+600000,resultId]);
}

test('restart recovery moves attempted jobs to uncertain and never resets committed publications',async()=>{
 const {db,c}=await fixture();
 try{
  await insertJob(db,{id:'00000000-0000-4000-8000-000000000071',attempted:true,attemptedAt:now});
  await insertJob(db,{id:'00000000-0000-4000-8000-000000000072',attempted:false,scheduledAt:now+5000});
  await insertJob(db,{id:'00000000-0000-4000-8000-000000000073',attempted:false,retryCount:3});
  await insertJob(db,{id:'00000000-0000-4000-8000-000000000074',status:'published',attempted:true,attemptedAt:now,resultId:'1891234567890123456'});
  await insertJob(db,{id:'00000000-0000-4000-8000-000000000075',status:'uncertain',attempted:true,attemptedAt:now});
  await db.query("INSERT INTO xc_auto_reconcile(job_id,account_name,expected_handle,kind,attempted_at,next_check_at,deadline_at,status,created_at,updated_at) VALUES($1,'publisher','publisher','post',$2,$3,$4,'running',$2,$2)",['00000000-0000-4000-8000-000000000075',now,now+5000,now+RECONCILIATION_WINDOW_MS]);
  await db.query("INSERT INTO xc_auto_reconcile(job_id,account_name,expected_handle,kind,attempted_at,next_check_at,deadline_at,status,created_at,updated_at,finished_at,matched_tweet_id) VALUES($1,'publisher','publisher','post',$2,$2,$3,'resolved',$2,$2,$2,'1891234567890123456')",['00000000-0000-4000-8000-000000000074',now,now+RECONCILIATION_WINDOW_MS]);
  await db.query("INSERT INTO xc_auto_sync(id,account_name,expected_handle,tweet_id,status,created_at) VALUES('sync-1','publisher','publisher','1891234567890123456','running',$1)",[now]);
  const result=await recoverInterruptedJobs(c,now+60_000);
  assert.equal(result.interruptedJobs,3);
  assert.equal(result.syncJobs,1);
  assert.equal(result.reconciliationsReset,1);
  const attempted=(await db.query<{status:string,retry_count:number,lease_until:number|null}>('SELECT status,retry_count,lease_until FROM xc_auto_jobs WHERE id=$1',['00000000-0000-4000-8000-000000000071'])).rows[0];
  assert.deepEqual(attempted,{status:'uncertain',retry_count:0,lease_until:null});
  const reconciliation=(await db.query<{status:string,next_check_at:number,deadline_at:number}>('SELECT status,next_check_at,deadline_at FROM xc_auto_reconcile WHERE job_id=$1',['00000000-0000-4000-8000-000000000071'])).rows[0];
  assert.deepEqual(reconciliation,{status:'queued',next_check_at:now+60_000,deadline_at:now+RECONCILIATION_WINDOW_MS});
  const preSend=(await db.query<{status:string,retry_count:number,scheduled_at:number,started_at:number|null,finished_at:number|null}>('SELECT status,retry_count,scheduled_at,started_at,finished_at FROM xc_auto_jobs WHERE id=$1',['00000000-0000-4000-8000-000000000072'])).rows[0];
  assert.deepEqual(preSend,{status:'queued',retry_count:1,scheduled_at:now+90_000,started_at:null,finished_at:null});
  const exhausted=(await db.query<{status:string,retry_count:number,finished_at:number}>('SELECT status,retry_count,finished_at FROM xc_auto_jobs WHERE id=$1',['00000000-0000-4000-8000-000000000073'])).rows[0];
  assert.deepEqual(exhausted,{status:'failed',retry_count:3,finished_at:now+60_000});
  assert.equal((await db.query<{status:string}>('SELECT status FROM xc_auto_jobs WHERE id=$1',['00000000-0000-4000-8000-000000000074'])).rows[0].status,'published');
  assert.equal((await db.query<{status:string,matched_tweet_id:string}>('SELECT status,matched_tweet_id FROM xc_auto_reconcile WHERE job_id=$1',['00000000-0000-4000-8000-000000000074'])).rows[0].status,'resolved');
  assert.equal((await db.query<{status:string}>('SELECT status FROM xc_auto_sync WHERE id=$1',['sync-1'])).rows[0].status,'queued');
  assert.equal((await db.query<{status:string}>('SELECT status FROM xc_auto_reconcile WHERE job_id=$1',['00000000-0000-4000-8000-000000000075'])).rows[0].status,'queued');
 }finally{await db.close();}
});

test('restart recovery queues fresh engagement actions for read-only observation and sends expired jobs to manual review',async()=>{
 const {db,c}=await fixture();
 try{
  await insertJob(db,{id:'00000000-0000-4000-8000-000000000081',status:'uncertain',kind:'post',attempted:true,attemptedAt:now-RECONCILIATION_WINDOW_MS-1});
  await insertJob(db,{id:'00000000-0000-4000-8000-000000000082',status:'uncertain',kind:'like',attempted:true,attemptedAt:now});
  await recoverInterruptedJobs(c,now+1000);
  const expired=(await db.query<{status:string,last_error:string,finished_at:number}>('SELECT status,last_error,finished_at FROM xc_auto_reconcile WHERE job_id=$1',['00000000-0000-4000-8000-000000000081'])).rows[0];
  assert.equal(expired.status,'manual_required');
  assert.match(expired.last_error,/старше 24 часов/);
  assert.equal(expired.finished_at,now+1000);
  const engagement=(await db.query<{status:string,last_error:string|null,finished_at:number|null}>('SELECT status,last_error,finished_at FROM xc_auto_reconcile WHERE job_id=$1',['00000000-0000-4000-8000-000000000082'])).rows[0];
  assert.deepEqual(engagement,{status:'queued',last_error:null,finished_at:null});
  for(const kind of ['repost','follow']){
   const id=kind==='repost'?'00000000-0000-4000-8000-000000000083':'00000000-0000-4000-8000-000000000084';
   await insertJob(db,{id,status:'uncertain',kind,attempted:true,attemptedAt:now});
   await recoverInterruptedJobs(c,now+2000);
   assert.equal((await db.query<{status:string}>('SELECT status FROM xc_auto_reconcile WHERE job_id=$1',[id])).rows[0].status,'queued');
  }
 }finally{await db.close();}
});

test('restart recovery rolls back all related state if any recovery write fails',async()=>{
 const {db,c}=await fixture();
 try{
  const id='00000000-0000-4000-8000-000000000091';
  await insertJob(db,{id,attempted:true,attemptedAt:now});
  await db.query("INSERT INTO xc_auto_sync(id,account_name,expected_handle,tweet_id,status,created_at) VALUES('sync-fail','publisher','publisher','1891234567890123456','running',$1)",[now]);
  const before=(await db.query<{n:number}>('SELECT count(*)::int n FROM xc_auto_job_events WHERE job_id=$1',[id])).rows[0].n;
  await db.exec("CREATE FUNCTION reject_recovery_sync() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected recovery failure'; END $$; CREATE TRIGGER reject_recovery_sync BEFORE UPDATE ON xc_auto_sync FOR EACH ROW EXECUTE FUNCTION reject_recovery_sync()");
  await assert.rejects(recoverInterruptedJobs(c,now+1000),/injected recovery failure/);
  assert.equal((await db.query<{status:string}>('SELECT status FROM xc_auto_jobs WHERE id=$1',[id])).rows[0].status,'running');
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM xc_auto_reconcile WHERE job_id=$1',[id])).rows[0].n,0);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM xc_auto_job_events WHERE job_id=$1',[id])).rows[0].n,before);
  await db.exec('DROP TRIGGER reject_recovery_sync ON xc_auto_sync');
  await recoverInterruptedJobs(c,now+1000);
  assert.equal((await db.query<{status:string}>('SELECT status FROM xc_auto_jobs WHERE id=$1',[id])).rows[0].status,'uncertain');
 }finally{await db.close();}
});
