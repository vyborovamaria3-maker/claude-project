import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createRequire} from 'node:module';

const load=createRequire(__filename);
const {claim}=load('../scripts/autopost/queue.cjs');
const {finalizePublication}=load('../scripts/autopost/finalize.cjs');
const schema=readFileSync('scripts/autopost/schema.sql','utf8');
const tweetId='1891234567890123456';
const now=1_800_000_000_000;

async function fixture(){
 const db=new PGlite();
 await db.exec("CREATE TABLE x_accounts(name text PRIMARY KEY,role text NOT NULL,status text NOT NULL,account_busy_until bigint,publisher_handle text,updated_at bigint NOT NULL DEFAULT 0);CREATE TABLE x_tasks(id bigint PRIMARY KEY)");
 await db.exec("CREATE TABLE twitter_tweets(tweet_id text PRIMARY KEY,handle text,text text,url text,posted_at bigint,first_seen_at bigint,updated_at bigint,source_query text,views bigint,likes bigint,replies bigint,retweets bigint)");
 await db.exec(schema);
 const c={query:async(q:string,params:unknown[]=[] )=>{
   const r=await db.query(q,params);
   return {rows:r.rows,rowCount:r.affectedRows??r.rows.length};
 }};
 await db.query("INSERT INTO x_accounts(name,role,status,account_busy_until) VALUES('publisher','publisher','active',0)");
 return {db,c};
}
async function runningJob(db:PGlite,c:ReturnType<typeof fixture> extends Promise<infer R> ? R['c'] : never,id:string){
 await db.query("INSERT INTO xc_auto_jobs(id,account_name,expected_handle,kind,content,dedup,scheduled_at,created_at,origin) VALUES($1,'publisher','publisher','post','test publication',$2,$3,$3,'manual')",[id,'final-'+id,now]);
 assert.equal(await claim(c,{id,account_name:'publisher'},now),true);
 await db.query('UPDATE xc_auto_jobs SET attempted=true,attempted_at=$2 WHERE id=$1',[id,now+10]);
 return {id,account_name:'publisher',expected_handle:'publisher',content:'test publication'};
}

test('V2-02 confirmed X post is persisted and published together, idempotently',async()=>{
 const {db,c}=await fixture();const id='00000000-0000-4000-8000-000000000061';
 try{
  const job=await runningJob(db,c,id);
  assert.deepEqual(await finalizePublication(c,job,tweetId,{views:'10'},{expectedStatus:'running',message:'Verified by X'}),{ok:true,alreadyConfirmed:false});
  assert.deepEqual(await finalizePublication(c,job,tweetId,{views:'10'},{expectedStatus:'running'}),{ok:true,alreadyConfirmed:true});
  assert.equal((await db.query<{status:string,result_id:string}>('SELECT status,result_id FROM xc_auto_jobs WHERE id=$1',[id])).rows[0].status,'published');
  assert.equal((await db.query<{result_id:string}>('SELECT result_id FROM xc_auto_jobs WHERE id=$1',[id])).rows[0].result_id,tweetId);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM xc_auto_posts WHERE tweet_id=$1',[tweetId])).rows[0].n,1);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM twitter_tweets WHERE tweet_id=$1',[tweetId])).rows[0].n,1);
  assert.equal((await db.query<{n:number}>("SELECT count(*)::int n FROM xc_auto_job_events WHERE job_id=$1 AND event_type='published'",[id])).rows[0].n,1);
 }finally{await db.close();}
});

test('V2-02 failure on status audit rolls back post, timeline, metrics and job',async()=>{
 const {db,c}=await fixture();const id='00000000-0000-4000-8000-000000000062';
 try{
  const job=await runningJob(db,c,id);
  await db.exec("CREATE FUNCTION reject_finalize() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='published' THEN RAISE EXCEPTION 'injected finalization failure'; END IF; RETURN NEW; END $$;");
  await db.exec("CREATE TRIGGER reject_finalize BEFORE INSERT ON xc_auto_job_events FOR EACH ROW EXECUTE FUNCTION reject_finalize()");
  await assert.rejects(finalizePublication(c,job,tweetId,{views:'10'},{expectedStatus:'running'}),/injected finalization failure/);
  assert.equal((await db.query<{status:string}>('SELECT status FROM xc_auto_jobs WHERE id=$1',[id])).rows[0].status,'running');
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM xc_auto_posts')).rows[0].n,0);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM twitter_tweets')).rows[0].n,0);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM xc_auto_metrics')).rows[0].n,0);
  await db.exec('DROP TRIGGER reject_finalize ON xc_auto_job_events');
  await finalizePublication(c,job,tweetId,{}, {expectedStatus:'running'});
  assert.equal((await db.query<{status:string}>('SELECT status FROM xc_auto_jobs WHERE id=$1',[id])).rows[0].status,'published');
 }finally{await db.close();}
});

test('V2-02 reconciliation finalizes post and the matching reconciliation atomically',async()=>{
 const {db,c}=await fixture();const id='00000000-0000-4000-8000-000000000063';
 try{
  const job=await runningJob(db,c,id);
  await db.query("UPDATE xc_auto_jobs SET status='uncertain' WHERE id=$1",[id]);
  await db.query("INSERT INTO xc_auto_reconcile(job_id,account_name,expected_handle,kind,attempted_at,next_check_at,deadline_at,status,created_at,updated_at) VALUES($1,'publisher','publisher','post',$2,$2,$3,'running',$2,$2)",[id,now,now+60_000]);
  await assert.rejects(finalizePublication(c,job,tweetId,{}, {expectedStatus:'uncertain',reconciliationStates:['manual_review']}),/Reconciliation status changed/);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM xc_auto_posts')).rows[0].n,0);
  const finalized=await finalizePublication(c,job,tweetId,{}, {expectedStatus:'uncertain',reconciliationStates:['running'],candidates:'[]',message:'Reconciled'});
  assert.equal(finalized.alreadyConfirmed,false);
  const reconcile=(await db.query<{status:string,matched_tweet_id:string}>('SELECT status,matched_tweet_id FROM xc_auto_reconcile WHERE job_id=$1',[id])).rows[0];
  assert.deepEqual(reconcile,{status:'resolved',matched_tweet_id:tweetId});
  assert.equal((await db.query<{status:string}>('SELECT status FROM xc_auto_jobs WHERE id=$1',[id])).rows[0].status,'published');
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM xc_auto_posts',[id])).rows[0].n,1);
 }finally{await db.close();}
});
