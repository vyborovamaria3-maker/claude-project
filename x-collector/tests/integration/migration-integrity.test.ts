import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {REQUIRED} from '../../lib/trade/migrations';

test('native PostgreSQL migration CLI detects drift before DDL and explicitly baselines legacy ledgers',{
 skip:!process.env.RUNTIME_TEST_DATABASE_URL,timeout:90000,
},async()=>{
 const url=new URL(process.env.RUNTIME_TEST_DATABASE_URL!);
 assert(url.pathname.endsWith('_test'));
 const schema='migration_'+randomUUID().replaceAll('-','');
 const admin=new Client({connectionString:url.toString()});await admin.connect();
 let c:Client|undefined;
 try{
  await admin.query('CREATE SCHEMA '+schema);
  url.searchParams.set('options','-c search_path='+schema+',public');
  c=new Client({connectionString:url.toString()});await c.connect();
  const cli=(...args:string[])=>new Promise<{code:number|null;output:string}>((resolve,reject)=>{
   const child=spawn(process.execPath,['--import','tsx','scripts/migrate.ts',...args],{env:{...process.env,DATABASE_URL:url.toString()}});
   let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});child.on('error',reject);child.on('exit',code=>resolve({code,output}));
  });
  assert.equal((await cli('--status')).code,0);
  assert.equal((await c.query("SELECT to_regclass('schema_migrations') present")).rows[0].present,null);
  const applied=await cli();assert.equal(applied.code,0,applied.output);
  assert.equal((await c.query('SELECT * FROM schema_migrations WHERE checksum IS NOT NULL')).rowCount,REQUIRED.length);
  assert.equal((await cli()).code,0);
  await c.query("UPDATE schema_migrations SET checksum='incorrect' WHERE filename=$1",[REQUIRED[0]]);
  assert.match((await cli('--status')).output,/checksum drift/);
  assert.notEqual((await cli('--baseline-checksums')).code,0);
  await c.query('ALTER TABLE schema_migrations DROP COLUMN checksum');
  const status=await cli('--status');assert.equal(status.code,0);assert.match(status.output,/unverified/);
  assert.notEqual((await cli()).code,0);
  const baseline=await cli('--baseline-checksums');assert.equal(baseline.code,0,baseline.output);
  assert.equal((await cli()).code,0);
 }finally{await c?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}
});
