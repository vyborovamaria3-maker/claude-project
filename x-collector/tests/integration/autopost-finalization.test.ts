import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {Client} from 'pg';

const load=createRequire(__filename);
const {finalizePublication}=load('../../scripts/autopost/finalize.cjs');

test('real PostgreSQL: concurrent reconciliation finalization has one consistent result', {
 skip:!process.env.RUNTIME_TEST_DATABASE_URL,timeout:60000,
},async()=>{
 const connectionString=process.env.RUNTIME_TEST_DATABASE_URL!;
 const url=new URL(connectionString);
 assert(url.pathname.endsWith('_test'),'Requires dedicated *_test PostgreSQL');
 const schema='autopost_finalize_'+randomUUID().replaceAll('-','');
 const admin=new Client({connectionString});
 const first=new Client({connectionString});
 const second=new Client({connectionString});
 await admin.connect();
 let created=false;
 try{
  await admin.query('CREATE SCHEMA "'+schema+'"');created=true;
  await Promise.all([first.connect(),second.connect()]);
  for(const c of [admin,first,second])await c.query('SET search_path TO "'+schema+'",public');
  await admin.query("CREATE TABLE x_accounts(name text PRIMARY KEY,role text,status text,account_busy_until bigint,publisher_handle text,updated_at bigint NOT NULL DEFAULT 0)");
  await admin.query("CREATE TABLE x_tasks(id bigint PRIMARY KEY)");
  await admin.query("CREATE TABLE twitter_tweets(tweet_id text PRIMARY KEY,handle text,text text,url text,posted_at bigint,first_seen_at bigint,updated_at bigint,source_query text,views bigint,likes bigint,replies bigint,retweets bigint)");
  const sql=readFileSync('scripts/autopost/schema.sql','utf8');
  await admin.query(sql);
  await admin.query(sql);
  await admin.query("INSERT INTO x_accounts(name,role,status,account_busy_until) VALUES('publisher','publisher','active',0)");
  const id=randomUUID(),tweetId='1891234567890123456',now=Date.now();
  const job={id,account_name:'publisher',expected_handle:'publisher',content:'test publication'};
  await admin.query("INSERT INTO xc_auto_jobs(id,account_name,expected_handle,kind,content,dedup,scheduled_at,created_at,origin) VALUES($1,'publisher','publisher','post','test publication',$2,$3,$3,'manual')",[id,'final-'+id,now]);
  await admin.query("UPDATE xc_auto_jobs SET status='running',attempted=true,attempted_at=$2,started_at=$2 WHERE id=$1",[id,now]);
  await admin.query("UPDATE xc_auto_jobs SET status='uncertain' WHERE id=$1",[id]);
  await admin.query("INSERT INTO xc_auto_reconcile(job_id,account_name,expected_handle,kind,attempted_at,next_check_at,deadline_at,status,created_at,updated_at) VALUES($1,'publisher','publisher','post',$2,$2,$3,'running',$2,$2)",[id,now,now+600000]);
  const [a,b]=await Promise.all([
   finalizePublication(first,job,tweetId,{views:'7'},{expectedStatus:'uncertain',reconciliationStates:['running'],message:'Confirmed'}),
   finalizePublication(second,job,tweetId,{views:'7'},{expectedStatus:'uncertain',reconciliationStates:['running'],message:'Confirmed'}),
  ]);
  assert.deepEqual([a.alreadyConfirmed,b.alreadyConfirmed].sort(),[false,true]);
  assert.equal((await admin.query<{status:string}>('SELECT status FROM xc_auto_jobs WHERE id=$1',[id])).rows[0].status,'published');
  assert.equal((await admin.query<{status:string}>('SELECT status FROM xc_auto_reconcile WHERE job_id=$1',[id])).rows[0].status,'resolved');
  assert.equal((await admin.query<{n:number}>('SELECT count(*)::int n FROM xc_auto_posts WHERE tweet_id=$1',[tweetId])).rows[0].n,1);
  assert.equal((await admin.query<{n:number}>("SELECT count(*)::int n FROM xc_auto_job_events WHERE job_id=$1 AND event_type='published'",[id])).rows[0].n,1);
  const failingJob=randomUUID(),failingTweet='1891234567890123457';
  await admin.query("INSERT INTO xc_auto_jobs(id,account_name,expected_handle,kind,content,dedup,scheduled_at,created_at,origin) VALUES($1,'publisher','publisher','post','test publication',$2,$3,$3,'manual')",[failingJob,'final-'+failingJob,now]);
  await admin.query("UPDATE xc_auto_jobs SET status='running',attempted=true,attempted_at=$2 WHERE id=$1",[failingJob,now]);
  await admin.query("CREATE FUNCTION reject_finalized_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='published' THEN RAISE EXCEPTION 'forced finalize rollback'; END IF; RETURN NEW; END $$");
  await admin.query("CREATE TRIGGER reject_finalized_event BEFORE INSERT ON xc_auto_job_events FOR EACH ROW EXECUTE FUNCTION reject_finalized_event()");
  await assert.rejects(finalizePublication(first,{...job,id:failingJob},failingTweet,{}, {expectedStatus:'running'}),/forced finalize rollback/);
  assert.equal((await admin.query<{status:string}>('SELECT status FROM xc_auto_jobs WHERE id=$1',[failingJob])).rows[0].status,'running');
  assert.equal((await admin.query<{n:number}>('SELECT count(*)::int n FROM xc_auto_posts WHERE tweet_id=$1',[failingTweet])).rows[0].n,0);
 }finally{
  await Promise.all([first.end().catch(()=>{}),second.end().catch(()=>{})]);
  try{if(created)await admin.query('DROP SCHEMA "'+schema+'" CASCADE');}finally{await admin.end().catch(()=>{});}
 }
});
