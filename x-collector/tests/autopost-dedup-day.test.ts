import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const load=createRequire(__filename);
const {enqueue,scheduledDedupDay}=load('../scripts/autopost/store.cjs');
const {digest}=load('../scripts/autopost/runtime.cjs');
const {fingerprints}=load('../scripts/autopost/fingerprint.cjs');
const schema=readFileSync('scripts/autopost/schema.sql','utf8');
const DAY_MS=86_400_000;
const make=(id:string,at:number,text='Unique research checklist')=>({id,name:'publisher',expected:'publisher',kind:'post',text,scheduled_at:at});
async function fixture(){
 const db=new PGlite();
 await db.exec("CREATE TABLE x_accounts(name text PRIMARY KEY,role text,status text);CREATE TABLE x_tasks(id bigint PRIMARY KEY)");
 await db.exec(schema);
 await db.query("INSERT INTO x_accounts VALUES('publisher','publisher','active')");
 const c={query:(sql:string,args:unknown[]=[])=>db.query(sql,args)};
 return {db,c};
}
test('V2-05: buckets use Moscow calendar date and preserve time across retry',()=>{
 const moment=Date.parse('2026-10-19T20:59:59Z');
 assert.equal(scheduledDedupDay(moment),'2026-10-19');
 assert.equal(scheduledDedupDay(moment+2000),'2026-10-20');
});
test('V2-05: same-day duplicate is rejected; tomorrow is allowed after confirmed publication',async()=>{
 const {db,c}=await fixture();
 const now=Date.now();
 try{
  const first=await enqueue(c,make(randomUUID(),now));
  const repeated=await enqueue(c,make(randomUUID(),now));
  assert.equal(repeated.id,first.id);
  await db.query("UPDATE xc_auto_jobs SET status='published',attempted=true,attempted_at=$2 WHERE id=$1",[first.id,now]);
  const tomorrow=await enqueue(c,make(randomUUID(),now+DAY_MS));
  assert.notEqual(tomorrow.id,first.id);
  assert.equal((await db.query<{count:number}>("SELECT count(*)::int AS count FROM xc_auto_jobs")).rows[0].count,2);
  const stored=(await db.query<{content_hash:string,dedup_day:string}>("SELECT content_hash,dedup_day::text FROM xc_auto_jobs ORDER BY created_at")).rows;
  assert.equal(stored[0].content_hash,stored[1].content_hash);
  assert.notEqual(stored[0].dedup_day,stored[1].dedup_day);
  await db.exec(schema);
  assert.equal((await db.query<{count:number}>("SELECT count(*)::int AS count FROM xc_auto_jobs")).rows[0].count,2);
 }finally{await db.close();}
});
test('V2-05: uncertain or attempted running job blocks tomorrow enqueue',async()=>{
 const {db,c}=await fixture();
 const now=Date.now();
 try{
  const first=await enqueue(c,make(randomUUID(),now));
  await db.query("UPDATE xc_auto_jobs SET status='running',attempted=true,attempted_at=$2 WHERE id=$1",[first.id,now]);
  assert.equal((await enqueue(c,make(randomUUID(),now+DAY_MS))).id,first.id);
  await db.query("UPDATE xc_auto_jobs SET status='uncertain' WHERE id=$1",[first.id]);
  assert.equal((await enqueue(c,make(randomUUID(),now+DAY_MS))).id,first.id);
  assert.equal((await db.query<{count:number}>("SELECT count(*)::int AS count FROM xc_auto_jobs")).rows[0].count,1);
 }finally{await db.close();}
});
test('V2-05: true pre-V2 fingerprints block same-day and uncertain next-day posts',async()=>{
 const {db,c}=await fixture();const now=Date.now(),id=randomUUID();
 try{
  const legacy=digest(['publisher','post','','unique research checklist'].join('|'));
  const modern=fingerprints({name:'publisher',kind:'post',text:'Unique research checklist'}).contentHash;
  assert.notEqual(legacy,modern);
  await db.query("INSERT INTO xc_auto_jobs(id,account_name,expected_handle,kind,content,dedup,scheduled_at,created_at,status,attempted) VALUES($1,'publisher','publisher','post','Unique research checklist',$2,$3,$3,'uncertain',true)",[id,legacy,now]);
  await db.exec(schema);
  assert.equal((await enqueue(c,make(randomUUID(),now+DAY_MS))).id,id,'Uncertain pre-V2 send cannot repeat next day');
  await db.query("UPDATE xc_auto_jobs SET status='published' WHERE id=$1",[id]);
  assert.equal((await enqueue(c,make(randomUUID(),now))).id,id,'Legacy same-day job is not duplicated');
  assert.notEqual((await enqueue(c,make(randomUUID(),now+DAY_MS))).id,id,'Confirmed next-day is allowed');
 }finally{await db.close();}
});

test('V2-05: a failed enqueue rolls back and account remains usable',async()=>{
 const {db,c}=await fixture();
 try{
  await assert.rejects(enqueue(c,make(randomUUID(),Date.now(),'  ')),/Текст/);
  assert.ok((await enqueue(c,make(randomUUID(),Date.now()))).id);
 }finally{await db.close();}
});
