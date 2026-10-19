import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const load=createRequire(__filename);
const b=load('../scripts/autopost/breaker.cjs');
const now=1_800_000_000_000;
async function fixture(){
 const db=new PGlite();
 await db.exec("CREATE TABLE x_accounts(name text PRIMARY KEY); CREATE TABLE x_tasks(id bigint PRIMARY KEY)");
 const schema=readFileSync('scripts/autopost/schema.sql','utf8');
 await db.exec(schema);await db.exec(schema);
 const c={query:(text:string,values:unknown[]=[])=>db.query(text,values)};
 return {db,c};
}
test('V2-06: three matching account failures open for 1h and half-open is single-use',async()=>{
 const {db,c}=await fixture();
 try{
  assert.equal(await b.permit(c,'account','publisher',now),true);
  assert.equal(await b.failure(c,'account','publisher','TEMPORARY_NETWORK',now),null,'Unrelated failures do not count');
  await b.failure(c,'account','publisher','PROXY_FAILED',now);
  await b.failure(c,'account','publisher','SESSION_EXPIRED',now+1);
  assert.equal((await b.failure(c,'account','publisher','X_RESTRICTED',now+2)).state,'open');
  assert.equal(await b.permit(c,'account','publisher',now+2),false);
  assert.equal(await b.permit(c,'account','publisher',now+3600_001),false);
  assert.equal(await b.permit(c,'account','publisher',now+3600_002),true);
  assert.equal(await b.permit(c,'account','publisher',now+3600_003),false);
  assert.equal((await b.failure(c,'account','publisher','X_RESTRICTED',now+3600_004)).state,'open','Failed probe immediately opens breaker');
  assert.equal((await db.query<{resume_at:number}>("SELECT resume_at FROM xc_auto_breakers WHERE subject='publisher'")).rows[0].resume_at,now+3600_004+3600000);
 }finally{await db.close();}
});
test('V2-06: AI opens at five failures, successful probe clears the breaker',async()=>{
 const {db,c}=await fixture();
 try{
  for(let i=0;i<5;i++)await assert.rejects(b.runAi(c,'provider',async()=>{throw Error('sensitive API token');}),/sensitive API token/);
  const opened=(await b.readBreakers(c))[0];
  assert.equal(opened.state,'open');
  assert.equal(opened.consecutive_failures,5);
  assert.equal(opened.reason_code,'AI_PROVIDER_FAILURE');
  assert.equal(opened.resume_at,String(Number(opened.updated_at)+30*60_000));
  let called=0;
  await assert.rejects(b.runAi(c,'provider',async()=>{called++;}),/AI_PROVIDER_PAUSED/);
  assert.equal(called,0);
  assert.equal(await b.permit(c,'ai','provider',Number(opened.resume_at)),true);
  // Permit was claimed, so a second actor cannot enter half-open.
  await assert.rejects(b.runAi(c,'provider',async()=>{called++;}),/AI_PROVIDER_PAUSED/);
  await b.success(c,'ai','provider');
  assert.equal(await b.runAi(c,'provider',async()=>42),42);
  assert.deepEqual(await b.readBreakers(c),[]);
 }finally{await db.close();}
});
test('V2-06: operator reset is explicit; failures never persist raw exception text',async()=>{
 const {db,c}=await fixture();
 try{
  await b.failure(c,'account','publisher','SESSION_EXPIRED',now);
  await assert.rejects(b.operatorReset(c,'account','publisher',false),/confirm/);
  await b.operatorReset(c,'account','publisher',true);
  assert.deepEqual(await b.readBreakers(c),[]);
  await assert.rejects(b.failure(c,'ai','provider','raw-secret-value/xyz'),/Invalid breaker error code/);
 }finally{await db.close();}
});
test('V2-06: fail-safe rollback on SQL persistence errors',async()=>{
 const {db,c}=await fixture();
 try{
  await db.exec("CREATE FUNCTION reject_breaker_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected breakage'; END $$; CREATE TRIGGER reject_breaker BEFORE INSERT ON xc_auto_breakers FOR EACH ROW EXECUTE FUNCTION reject_breaker_write()");
  await assert.rejects(b.failure(c,'ai','provider','AI_PROVIDER_FAILURE',now),/injected breakage/);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM xc_auto_breakers')).rows[0].n,0);
  await db.exec('DROP TRIGGER reject_breaker ON xc_auto_breakers');
  assert.equal((await b.failure(c,'ai','provider','AI_PROVIDER_FAILURE',now)).failures,1);
 }finally{await db.close();}
});

test('V2-06: unfinished half-open probe is released on pre-send retry and eventually expires after crashes',async()=>{
 const {db,c}=await fixture();
 try{
  for(let n=0;n<3;n++)await b.failure(c,'account','publisher','SESSION_EXPIRED',now+n);
  const resume=now+2+b.POLICY.account.cooldownMs;
  assert.equal(await b.permit(c,'account','publisher',resume),true);
  assert.equal(await b.releaseProbe(c,'account','publisher',resume+500),true);
  assert.equal((await db.query<{state:string}>("SELECT state FROM xc_auto_breakers WHERE subject='publisher'")).rows[0].state,'open');
  assert.equal(await b.permit(c,'account','publisher',resume+500),false);
  const second=resume+500+b.POLICY.account.cooldownMs;
  assert.equal(await b.permit(c,'account','publisher',second),true);
  assert.equal(await b.expireProbes(c,second+b.PROBE_TIMEOUT_MS-1),0);
  assert.equal(await b.expireProbes(c,second+b.PROBE_TIMEOUT_MS),1);
  assert.equal((await db.query<{state:string}>("SELECT state FROM xc_auto_breakers WHERE subject='publisher'")).rows[0].state,'open');
  assert.equal(await b.permit(c,'account','publisher',second+b.PROBE_TIMEOUT_MS+b.POLICY.account.cooldownMs),true);
 }finally{await db.close();}
});
