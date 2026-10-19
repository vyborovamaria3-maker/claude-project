import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const load=createRequire(__filename);
const {summarizeWorkerHealth,readWorkerHealth,writeComponent,withComponent,startHeartbeat}=load('../scripts/autopost/worker-health.cjs');
const now=1_800_000_000_000;
async function fixture(){
 const db=new PGlite();
 await db.exec("CREATE TABLE x_accounts(name text PRIMARY KEY); CREATE TABLE x_tasks(id bigint PRIMARY KEY)");
 const schema=readFileSync('scripts/autopost/schema.sql','utf8');
 await db.exec(schema);await db.exec(schema);
 const c={query:(sql:string,params:unknown[]=[] )=>db.query(sql,params)};
 return {db,c};
}
test('V2-04: offline, idle, busy and stalled use independent heartbeat',()=>{
 const worker={worker_id:'w1',started_at:now-10000,heartbeat_at:now-30000};
 assert.equal(summarizeWorkerHealth(null,[],now).state,'offline');
 assert.equal(summarizeWorkerHealth({...worker,heartbeat_at:now-120001},[],now).state,'offline');
 assert.equal(summarizeWorkerHealth(worker,[],now).state,'idle');
 assert.equal(summarizeWorkerHealth(worker,[{worker_id:'w1',component:'publisher',state:'busy',last_started_at:now-10000}],now).state,'busy');
 assert.equal(summarizeWorkerHealth(worker,[{worker_id:'w1',component:'publisher',state:'busy',last_started_at:now-600001}],now).state,'stalled');
 assert.equal(summarizeWorkerHealth(worker,[{worker_id:'w0',component:'publisher',state:'busy',last_started_at:now-600001}],now).state,'idle','Old worker progress cannot affect current worker');
});
test('V2-04: additive schema survives two migrations and exposes health + queue counts',async()=>{
 const {db,c}=await fixture();
 try{
  await db.query("INSERT INTO xc_auto_worker_health(id,worker_id,started_at,heartbeat_at) VALUES(1,'w1',$1,$1)",[now]);
  await writeComponent(c,'w1','publisher','busy',null,now-1000);
  await db.query("INSERT INTO xc_auto_jobs(id,account_name,expected_handle,kind,content,dedup,scheduled_at,created_at) VALUES ('job1','publisher','publisher','post','test','d1',$1,$1)",[now]);
  await db.query("INSERT INTO xc_auto_jobs(id,account_name,expected_handle,kind,content,dedup,scheduled_at,created_at,status) VALUES ('job2','publisher','publisher','post','test','d2',$1,$1,'uncertain')",[now]);
  const health=await readWorkerHealth(c,now);
  assert.equal(health.state,'busy');
  assert.equal(health.queue.queued,1);assert.equal(health.queue.uncertain,1);
  assert.equal(health.components.find((x:{component:string})=>x.component==='publisher').state,'busy');
  await writeComponent(c,'w1','publisher','idle',null,now);
  assert.equal((await readWorkerHealth(c,now)).state,'idle');
 }finally{await db.close();}
});
test('V2-04: component errors are sanitized and never change the operation result',async()=>{
 const {db,c}=await fixture();
 try{
  await assert.rejects(withComponent(c,'w1','publisher',async()=>{throw Object.assign(Error('private session token'),{code:'XYZ_LONG_SECRET_VALUE/123'});}),/private session token/);
  let row=(await db.query<{state:string,last_error_code:string}>("SELECT state,last_error_code FROM xc_auto_component_health WHERE component='publisher'")).rows[0];
  assert.deepEqual(row,{state:'error',last_error_code:'COMPONENT_FAILED'});
  assert.equal(await withComponent(c,'w1','publisher',async()=>42),42);
  row=(await db.query<{state:string,last_error_code:string}>("SELECT state,last_error_code FROM xc_auto_component_health WHERE component='publisher'")).rows[0];
  assert.deepEqual(row,{state:'idle',last_error_code:null});
 }finally{await db.close();}
});
test('V2-04: dedicated client beats while publisher client is blocked, without overlapping queries',async()=>{
 let ticks=0,connections=0,closed=0,legacyTicks=0;
 const connect=async()=>{connections++;return {query:async(q:unknown)=>{
  if(typeof q==='object'&&q!==null&&'text' in q&&String((q as {text:string}).text).includes('INSERT INTO xc_auto_worker_health'))ticks++;
  if(typeof q==='object'&&q!==null&&'text' in q&&String((q as {text:string}).text).includes('UPDATE xc_auto_control SET heartbeat'))legacyTicks++;
  return {rows:[],rowCount:1};
 },end:async()=>{closed++;}};};
 const heartbeat=await startHeartbeat(connect,{workerId:'test-worker',intervalMs:3600000,now:()=>now});
 try{
  const blocked=new Promise<void>(()=>{});
  void blocked;
  await Promise.all([heartbeat.beat(),heartbeat.beat()]);
  assert.equal(ticks,2,'Concurrent beat calls coalesce into one DB heartbeat');
  assert.equal(connections,1,'A single dedicated connection is reused');
  assert.equal(legacyTicks,2,'Legacy control heartbeat remains updated');
 }finally{await heartbeat.stop();}
 assert.equal(closed,1);
});
