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
