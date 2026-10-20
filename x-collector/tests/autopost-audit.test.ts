import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createRequire} from 'node:module';

const load=createRequire(__filename);
const {claim}=load('../scripts/autopost/queue.cjs');

function job(id:string,at:number){
 return [id,'publisher','publisher','post','hello','audit-'+id,at,at,'manual'];
}
function insertSql(){return "INSERT INTO xc_auto_jobs(id,account_name,expected_handle,kind,content,dedup,scheduled_at,created_at,origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)";}
const now=1_800_000_000_000;

test('v2 audit schema is replayable, append-only and tracks attempts across manual retries',async()=>{
 const db=new PGlite();
 const sql=readFileSync('scripts/autopost/schema.sql','utf8');
 const c={query:async(q:string,params:unknown[]=[] )=>{
  const r=await db.query(q,params);
  return {rows:r.rows,rowCount:r.affectedRows??r.rows.length};
 }};
 try{
  await db.exec("CREATE TABLE x_accounts(name text PRIMARY KEY,role text NOT NULL,status text NOT NULL,account_busy_until bigint);CREATE TABLE x_tasks(id bigserial PRIMARY KEY);");
  await db.exec(sql);
  await db.exec(sql);
  await db.query("INSERT INTO x_accounts(name,role,status,account_busy_until) VALUES('publisher','publisher','active',0)");
  const id='00000000-0000-4000-8000-000000000001';
  await db.query(insertSql(),job(id,now));
  assert.deepEqual((await db.query<{event_type:string}>("SELECT event_type FROM xc_auto_job_events WHERE job_id=$1",[id])).rows.map(x=>x.event_type),['created']);
  assert.equal(await claim(c,{id,account_name:'publisher'},now),true);
  assert.equal((await db.query<{n:number}>("SELECT count(*)::int n FROM xc_auto_job_attempts WHERE job_id=$1",[id])).rows[0].n,1);
  await db.query("UPDATE xc_auto_jobs SET attempted=true,attempted_at=$2 WHERE id=$1",[id,now+20]);
  await db.query("UPDATE xc_auto_jobs SET status='uncertain',finished_at=$2 WHERE id=$1",[id,now+40]);
  await db.query("UPDATE xc_auto_jobs SET status='queued',attempted=false,attempted_at=NULL WHERE id=$1",[id]);
  await db.query("UPDATE x_accounts SET account_busy_until=0 WHERE name='publisher'");
  assert.equal(await claim(c,{id,account_name:'publisher'},now+100),true);
  await db.query("UPDATE xc_auto_jobs SET status='failed',finished_at=$2 WHERE id=$1",[id,now+200]);
  const attempts=await db.query<{attempt_no:number,status:string,boundary_at:string|null}>("SELECT attempt_no,status,boundary_at::text FROM xc_auto_job_attempts WHERE job_id=$1 ORDER BY attempt_no",[id]);
  assert.deepEqual(attempts.rows.map(x=>[x.attempt_no,x.status]),[[1,'uncertain'],[2,'failed']]);
  assert.equal(Number(attempts.rows[0].boundary_at),now+20);
  const events=await db.query<{event_type:string,attempt_id:string|null,payload:Record<string,unknown>}>("SELECT event_type,attempt_id,payload FROM xc_auto_job_events WHERE job_id=$1 ORDER BY event_id",[id]);
  assert.deepEqual(events.rows.map(x=>x.event_type),['created','claimed','boundary_recorded','uncertain','manual_retry_approved','claimed','failed']);
  assert.equal(events.rows[0].attempt_id,null);
  assert.ok(events.rows.slice(1).every(x=>typeof x.attempt_id==='string'));
  assert.ok(events.rows.every(x=>!JSON.stringify(x.payload).includes('hello')));
  await assert.rejects(db.query("UPDATE xc_auto_job_events SET event_type='tampered' WHERE job_id=$1",[id]),/append-only/);
  await assert.rejects(db.query("DELETE FROM xc_auto_job_events WHERE job_id=$1",[id]),/append-only/);
 }finally{await db.close();}
});

test('v2 error classifications are structured and do not leak messages',()=>{
 const {classifyAuditError}=load('../scripts/autopost/audit-error.cjs');
 assert.deepEqual(classifyAuditError(Object.assign(new Error('connection error'),{code:'23505'})),{category:'DB_ERROR',code:'PG_23505'});
 assert.deepEqual(classifyAuditError(new Error('HTTP 429 rate limit')), {category:'X_ERROR',code:'X_RESTRICTED'});
 assert.deepEqual(classifyAuditError(new Error('Задание остановлено до отправки')), {category:'VALIDATION_ERROR',code:'JOB_NOT_ELIGIBLE'});
 assert.deepEqual(classifyAuditError(new Error('Unknown error: private-api-key')), {category:'PROCESS_ERROR',code:'PRE_SEND_FAILED'});
});

test('v2 DB error audit keeps the same trace ID in error events',async()=>{
 const db=new PGlite();
 const sql=readFileSync('scripts/autopost/schema.sql','utf8');
 const {recordAttemptFailure}=load('../scripts/autopost/audit-error.cjs');
 const c={query:async(q:string,params:unknown[]=[] )=>{
   const r=await db.query(q,params);
   return {rows:r.rows,rowCount:r.affectedRows??r.rows.length};
 }};
 const id='00000000-0000-4000-8000-000000000003';
 try{
  await db.exec("CREATE TABLE x_accounts(name text PRIMARY KEY,role text,status text,account_busy_until bigint);CREATE TABLE x_tasks(id bigint PRIMARY KEY)");
  await db.exec(sql);
  await db.query("INSERT INTO x_accounts(name,role,status,account_busy_until) VALUES('publisher','publisher','active',0)");
  await db.query(insertSql(),job(id,now));
  assert.equal(await claim(c,{id,account_name:'publisher'},now),true);
  await db.exec('BEGIN');
  await db.query("UPDATE xc_auto_jobs SET status='failed' WHERE id=$1",[id]);
  await recordAttemptFailure(c,id,Object.assign(new Error('private-api-secret'),{code:'23505'}));
  await db.exec('COMMIT');
  const attempts=await db.query<{attempt_id:string,trace_id:string,error_category:string,error_code:string}>("SELECT attempt_id,trace_id,error_category,error_code FROM xc_auto_job_attempts WHERE job_id=$1",[id]);
  const events=await db.query<{event_type:string,attempt_id:string|null,trace_id:string|null,payload:unknown}>("SELECT event_type,attempt_id,trace_id,payload FROM xc_auto_job_events WHERE job_id=$1 ORDER BY event_id",[id]);
  assert.equal(attempts.rows[0].error_category,'DB_ERROR');
  assert.equal(attempts.rows[0].error_code,'PG_23505');
  assert.equal(events.rows.find(e=>e.event_type==='claimed')?.trace_id,attempts.rows[0].trace_id);
  const failure=events.rows.find(e=>e.event_type==='error_classified');
  assert.equal(failure?.trace_id,attempts.rows[0].trace_id);
  assert.equal(failure?.attempt_id,attempts.rows[0].attempt_id);
  assert.deepEqual(failure?.payload,{category:'DB_ERROR',code:'PG_23505'});
  assert.ok(!JSON.stringify(events.rows).includes('private-api-secret'));
 }finally{await db.close();}
});

test('v2 reconciliation checks keep the trace without recording raw X evidence',async()=>{
 const db=new PGlite();
 const sql=readFileSync('scripts/autopost/schema.sql','utf8');
 const id='00000000-0000-4000-8000-000000000004';
 const c={query:async(q:string,params:unknown[]=[] )=>{
  const r=await db.query(q,params);
  return {rows:r.rows,rowCount:r.affectedRows??r.rows.length};
 }};
 try{
  await db.exec("CREATE TABLE x_accounts(name text PRIMARY KEY,role text,status text,account_busy_until bigint);CREATE TABLE x_tasks(id bigint PRIMARY KEY)");
  await db.exec(sql);
  await db.query("INSERT INTO x_accounts(name,role,status,account_busy_until) VALUES('publisher','publisher','active',0)");
  await db.query(insertSql(),job(id,now));
  assert.equal(await claim(c,{id,account_name:'publisher'},now),true);
  await db.query("UPDATE xc_auto_jobs SET attempted=true,attempted_at=$2 WHERE id=$1",[id,now+10]);
  await db.query("UPDATE xc_auto_jobs SET status='uncertain' WHERE id=$1",[id]);
  await db.query("INSERT INTO xc_auto_reconcile(job_id,account_name,expected_handle,kind,attempted_at,next_check_at,deadline_at,status,created_at,updated_at) VALUES($1,'publisher','publisher','post',$2,$2,$3,'queued',$2,$2)",[id,now+10,now+100000]);
  await db.query("UPDATE xc_auto_reconcile SET status='running',attempts=1,last_error='sensitive cookie secret' WHERE job_id=$1",[id]);
  await db.query("UPDATE xc_auto_reconcile SET status='queued',next_check_at=$2 WHERE job_id=$1",[id,now+2000]);
  const result=await db.query<{event_type:string,trace_id:string,attempt_id:string,payload:unknown}>("SELECT event_type,trace_id,attempt_id,payload FROM xc_auto_job_events WHERE job_id=$1 AND event_type LIKE 'reconcile_%' ORDER BY event_id",[id]);
  assert.deepEqual(result.rows.map(x=>x.event_type),['reconcile_created','reconcile_status_changed','reconcile_status_changed']);
  const attempt=(await db.query<{trace_id:string,attempt_id:string}>("SELECT trace_id,attempt_id FROM xc_auto_job_attempts WHERE job_id=$1",[id])).rows[0];
  assert.ok(result.rows.every(x=>x.trace_id===attempt.trace_id&&x.attempt_id===attempt.attempt_id));
  assert.ok(!JSON.stringify(result.rows).includes('sensitive cookie secret'));
 }finally{await db.close();}
});

test('v2 audit rolls back job transitions when event persistence fails',async()=>{
 const db=new PGlite();
 const sql=readFileSync('scripts/autopost/schema.sql','utf8');
 try{
  await db.exec("CREATE TABLE x_accounts(name text PRIMARY KEY);CREATE TABLE x_tasks(id bigserial PRIMARY KEY);");
  await db.exec(sql);
  const id='00000000-0000-4000-8000-000000000002';
  await db.query(insertSql(),job(id,now));
  await db.exec("CREATE FUNCTION fail_auto_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='claimed' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_auto_audit BEFORE INSERT ON xc_auto_job_events FOR EACH ROW EXECUTE FUNCTION fail_auto_audit();");
  await assert.rejects(db.query("UPDATE xc_auto_jobs SET status='running',started_at=$2 WHERE id=$1",[id,now+1]),/injected audit failure/);
  assert.equal((await db.query<{status:string}>("SELECT status FROM xc_auto_jobs WHERE id=$1",[id])).rows[0].status,'queued');
  assert.equal((await db.query<{n:number}>("SELECT count(*)::int n FROM xc_auto_job_attempts WHERE job_id=$1",[id])).rows[0].n,0);
 }finally{await db.close();}
});
