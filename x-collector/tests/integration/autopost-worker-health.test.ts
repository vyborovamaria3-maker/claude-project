import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {Client} from 'pg';
const load=createRequire(__filename);
const {startHeartbeat,readWorkerHealth}=load('../../scripts/autopost/worker-health.cjs');

test('real PostgreSQL: a blocked publisher connection does not block heartbeat', {
 skip:!process.env.RUNTIME_TEST_DATABASE_URL,timeout:60000,
},async()=>{
 const connectionString=process.env.RUNTIME_TEST_DATABASE_URL!;
 assert(new URL(connectionString).pathname.endsWith('_test'),'Requires disposable *_test database');
 const schema='autopost_health_'+randomUUID().replaceAll('-','');
 const admin=new Client({connectionString});
 const primary=new Client({connectionString});
 let heartbeat:Awaited<ReturnType<typeof startHeartbeat>>|undefined;
 let schemaCreated=false;
 await admin.connect();
 try{
  await admin.query('CREATE SCHEMA "'+schema+'"');schemaCreated=true;
  await primary.connect();
  for(const c of [admin,primary])await c.query('SET search_path TO "'+schema+'",public');
  await admin.query('CREATE TABLE x_accounts(name text PRIMARY KEY)');
  await admin.query('CREATE TABLE x_tasks(id bigint PRIMARY KEY)');
  const sql=readFileSync('scripts/autopost/schema.sql','utf8');
  await admin.query(sql);await admin.query(sql);
  let connectionCount=0;
  const connect=async({onError}:{onError?:((err:Error)=>void)}={})=>{
   connectionCount++;
   const c=new Client({connectionString,connectionTimeoutMillis:5000});
   if(onError)c.on('error',onError);
   await c.connect();await c.query('SET search_path TO "'+schema+'",public');
   return c;
  };
  heartbeat=await startHeartbeat(connect,{workerId:'test-worker',intervalMs:3600000});
  // The original worker database connection is intentionally tied up.
  const blocked=primary.query('SELECT pg_sleep(0.5)');
  await heartbeat.beat();
  const fromIndependent=await readWorkerHealth(admin);
  assert.equal(fromIndependent.state,'idle');
  assert.equal(fromIndependent.worker_id,'test-worker');
  assert.equal(connectionCount,1,'Heartbeat must use its own single connection');
  await blocked;
  await heartbeat.stop();heartbeat=undefined;
  const stopped=await readWorkerHealth(admin);
  assert.equal(stopped.state,'offline','Graceful shutdown must be visible immediately');
 }finally{
  await heartbeat?.stop().catch(()=>{});
  await primary.end().catch(()=>{});
  try{if(schemaCreated)await admin.query('DROP SCHEMA "'+schema+'" CASCADE');}finally{await admin.end().catch(()=>{});}
 }
});
