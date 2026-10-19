import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {Client} from 'pg';
const load=createRequire(__filename);
const {enqueue}=load('../../scripts/autopost/store.cjs');
const {digest}=load('../../scripts/autopost/runtime.cjs');

test('real PostgreSQL: same-day concurrent enqueues serialize; uncertain blocks new-day duplicate', {
 skip:!process.env.RUNTIME_TEST_DATABASE_URL,timeout:60000,
},async()=>{
 const connectionString=process.env.RUNTIME_TEST_DATABASE_URL!;
 assert(new URL(connectionString).pathname.endsWith('_test'),'Requires isolated *_test database');
 const schema='autopost_day_'+randomUUID().replaceAll('-','');
 const admin=new Client({connectionString});
 const first=new Client({connectionString});
 const second=new Client({connectionString});
 let created=false;
 await admin.connect();
 try{
  await admin.query('CREATE SCHEMA "'+schema+'"');created=true;
  await Promise.all([first.connect(),second.connect()]);
  for(const c of [admin,first,second])await c.query('SET search_path TO "'+schema+'",public');
  await admin.query("CREATE TABLE x_accounts(name text PRIMARY KEY,role text,status text)");
  await admin.query('CREATE TABLE x_tasks(id bigint PRIMARY KEY)');
  const sql=readFileSync('scripts/autopost/schema.sql','utf8');
  await admin.query(sql);await admin.query(sql);
  await admin.query("INSERT INTO x_accounts VALUES('publisher','publisher','active')");
  const now=Date.now(),tomorrow=now+86_400_000;
  const make=(id:string,scheduled_at=now,text='Check these research steps')=>({id,name:'publisher',expected:'publisher',kind:'post',text,scheduled_at});
  const ids=[randomUUID(),randomUUID()];
  const results=await Promise.all([enqueue(first,make(ids[0])),enqueue(second,make(ids[1]))]);
  assert.equal(results[0].id,results[1].id,'Only one same-day job may be created');
  const id=results[0].id;
  assert.equal((await admin.query<{n:number}>('SELECT count(*)::int n FROM xc_auto_jobs')).rows[0].n,1);
  await admin.query("UPDATE xc_auto_jobs SET status='running',attempted=true,attempted_at=$2 WHERE id=$1",[id,now]);
  await admin.query("UPDATE xc_auto_jobs SET status='uncertain' WHERE id=$1",[id]);
  assert.equal((await enqueue(first,make(randomUUID(),tomorrow))).id,id,
   'Potentially sent action must block any next-day enqueue');
  assert.equal((await admin.query<{n:number}>('SELECT count(*)::int n FROM xc_auto_jobs')).rows[0].n,1);
  await admin.query("UPDATE xc_auto_jobs SET status='published' WHERE id=$1",[id]);
  const fresh=await enqueue(second,make(randomUUID(),tomorrow));
  assert.notEqual(fresh.id,id,'Once outcome is confirmed, tomorrow is a new bucket');
  const sameTomorrow=await enqueue(first,make(randomUUID(),tomorrow));
  assert.equal(sameTomorrow.id,fresh.id);
  assert.equal((await admin.query<{n:number}>('SELECT count(*)::int n FROM xc_auto_jobs')).rows[0].n,2);
  const contentHash=digest(['publisher','post','check these research steps'].join('|'));
  const indexed=(await admin.query<{n:number}>('SELECT count(*)::int n FROM xc_auto_jobs WHERE content_hash=$1',[contentHash])).rows[0].n;
  assert.equal(indexed,2);
 }finally{
  await Promise.all([first.end().catch(()=>{}),second.end().catch(()=>{})]);
  try{if(created)await admin.query('DROP SCHEMA "'+schema+'" CASCADE');}finally{await admin.end().catch(()=>{});}
 }
});
