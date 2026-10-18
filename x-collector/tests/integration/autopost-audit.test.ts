import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {Client} from 'pg';

const load=createRequire(__filename);
const {claim}=load('../../scripts/autopost/queue.cjs');

test('real PostgreSQL: v2 attempt audit is atomic across two concurrent clients', {
  skip:!process.env.RUNTIME_TEST_DATABASE_URL,timeout:45000,
},async()=>{
  const connectionString=process.env.RUNTIME_TEST_DATABASE_URL!;
  const url=new URL(connectionString);
  assert(url.pathname.endsWith('_test'),'Requires dedicated *_test PostgreSQL');
  const schema='autopost_audit_'+randomUUID().replaceAll('-','');
  const admin=new Client({connectionString});
  const first=new Client({connectionString});
  const second=new Client({connectionString});
  await admin.connect();
  let created=false;
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');created=true;
    await Promise.all([first.connect(),second.connect()]);
    for(const c of [admin,first,second])await c.query('SET search_path TO "'+schema+'",public');
    await admin.query("CREATE TABLE x_accounts(name text PRIMARY KEY,role text,status text,account_busy_until bigint)");
    await admin.query("CREATE TABLE x_tasks(id bigint PRIMARY KEY)");
    const sql=readFileSync('scripts/autopost/schema.sql','utf8');
    await admin.query(sql);
    await admin.query(sql); // Replay migration without touching old rows.
    await admin.query("INSERT INTO x_accounts(name,role,status,account_busy_until) VALUES('publisher','publisher','active',0)");
    const id=randomUUID(),now=Date.now();
    await admin.query("INSERT INTO xc_auto_jobs(id,account_name,expected_handle,kind,content,dedup,scheduled_at,created_at,origin) VALUES($1,'publisher','publisher','post','test',$2,$3,$3,'manual')",[id,'audit-'+id,now]);
    const [a,b]=await Promise.all([
      claim(first,{id,account_name:'publisher'},now),
      claim(second,{id,account_name:'publisher'},now),
    ]);
    assert.equal(Number(a)+Number(b),1,'Only one client can claim a job');
    let attempts=await admin.query<{attempt_no:number}>("SELECT attempt_no FROM xc_auto_job_attempts WHERE job_id=$1",[id]);
    assert.deepEqual(attempts.rows.map(r=>r.attempt_no),[1]);
    await admin.query("UPDATE xc_auto_jobs SET attempted=true,attempted_at=$2 WHERE id=$1",[id,now+10]);
    await admin.query("UPDATE xc_auto_jobs SET status='uncertain' WHERE id=$1",[id]);
    await admin.query("UPDATE xc_auto_jobs SET status='queued',attempted=false,attempted_at=NULL WHERE id=$1",[id]);
    await admin.query("UPDATE x_accounts SET account_busy_until=0 WHERE name='publisher'");
    const [nextA,nextB]=await Promise.all([
      claim(first,{id,account_name:'publisher'},now+100),
      claim(second,{id,account_name:'publisher'},now+100),
    ]);
    assert.equal(Number(nextA)+Number(nextB),1,'Manual retry can only be claimed once');
    attempts=await admin.query<{attempt_no:number}>("SELECT attempt_no FROM xc_auto_job_attempts WHERE job_id=$1 ORDER BY attempt_no",[id]);
    assert.deepEqual(attempts.rows.map(r=>r.attempt_no),[1,2]);
    const correlation=await admin.query<{attempt_no:number,attempt_trace:string,event_trace:string}>("SELECT a.attempt_no,a.trace_id attempt_trace,e.trace_id event_trace FROM xc_auto_job_attempts a JOIN xc_auto_job_events e ON e.attempt_id=a.attempt_id AND e.event_type='claimed' WHERE a.job_id=$1 ORDER BY a.attempt_no",[id]);
    assert.deepEqual(correlation.rows.map(r=>r.event_trace===r.attempt_trace),[true,true]);
    // Forced audit error must roll back the job status change AND the attempt update.
    await admin.query("CREATE FUNCTION reject_published_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='published' THEN RAISE EXCEPTION 'injected event failure'; END IF; RETURN NEW; END $$");
    await admin.query("CREATE TRIGGER reject_published_event BEFORE INSERT ON xc_auto_job_events FOR EACH ROW EXECUTE FUNCTION reject_published_event()");
    await assert.rejects(admin.query("UPDATE xc_auto_jobs SET status='published',finished_at=$2 WHERE id=$1",[id,now+120]),/injected event failure/);
    assert.equal((await admin.query<{status:string}>("SELECT status FROM xc_auto_jobs WHERE id=$1",[id])).rows[0].status,'running');
    assert.equal((await admin.query<{status:string}>("SELECT status FROM xc_auto_job_attempts WHERE job_id=$1 ORDER BY attempt_no DESC LIMIT 1",[id])).rows[0].status,'claimed');
    await admin.query("DROP TRIGGER reject_published_event ON xc_auto_job_events");
    await admin.query("UPDATE xc_auto_jobs SET status='published',finished_at=$2 WHERE id=$1",[id,now+130]);
    const events=await admin.query<{event_type:string}>("SELECT event_type FROM xc_auto_job_events WHERE job_id=$1 ORDER BY event_id",[id]);
    assert.deepEqual(events.rows.map(r=>r.event_type),['created','claimed','boundary_recorded','uncertain','manual_retry_approved','claimed','published']);
  }finally{
    await Promise.all([first.end().catch(()=>{}),second.end().catch(()=>{})]);
    try{if(created)await admin.query('DROP SCHEMA "'+schema+'" CASCADE');}finally{await admin.end().catch(()=>{});}
  }
});
