import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createCipheriv} from 'node:crypto';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {Client} from 'pg';
const load=createRequire(__filename);
const r=load('../../scripts/autopost/key-rotation-core.cjs');
function legacy(plain:Buffer,key:Buffer){
 const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);
 const body=Buffer.concat([c.update(plain),c.final()]);
 return Buffer.concat([iv,c.getAuthTag(),body]);
}
test('real PostgreSQL: disposable key rehearsal re-encrypts both tables and rolls back on any failure', {
 skip:!process.env.RUNTIME_TEST_DATABASE_URL,timeout:60_000,
},async()=>{
 const url=process.env.RUNTIME_TEST_DATABASE_URL!;
 assert(new URL(url).pathname.endsWith('_test'),'Dedicated *_test database required');
 const schema='autopost_rotation_'+randomUUID().replaceAll('-','');
 const client=new Client({connectionString:url,connectionTimeoutMillis:5000});
 const oldKey=randomBytes(32),newKey=randomBytes(32);
 let created=false;
 await client.connect();
 try{
  await client.query('CREATE SCHEMA "'+schema+'"');created=true;
  await client.query('SET search_path TO "'+schema+'",public');
  await client.query('CREATE TABLE x_accounts(name text PRIMARY KEY,session_encrypted bytea)');
  await client.query('CREATE TABLE xc_ai_providers(id text PRIMARY KEY,secret bytea)');
  const session=legacy(Buffer.from('{"cookies":[{"name":"auth_token","value":"test-only"}]}'),oldKey);
  const ai=legacy(Buffer.from('test-api-credential-no-value'),oldKey);
  await client.query("INSERT INTO x_accounts(name,session_encrypted) VALUES('test_account',$1)",[session]);
  await client.query("INSERT INTO xc_ai_providers(id,secret) VALUES('mock_ai',$1)",[ai]);
  await client.query('CREATE TABLE xc_auto_worker_health(id int PRIMARY KEY,heartbeat_at bigint)');
  await client.query('INSERT INTO xc_auto_worker_health(id,heartbeat_at) VALUES(1,$1)',[Date.now()]);
  const oldScan=await r.audit(client,{legacyKey:oldKey});
  assert.deepEqual(oldScan.counts,{x_accounts:{legacy:1,v2:0},xc_ai_providers:{legacy:1,v2:0}});
  const opts={legacyKey:oldKey,nextKey:newKey,nextId:'new_2026',keys:{new_2026:newKey},confirmedBackup:true,confirmedStopped:true};
  await assert.rejects(r.rotateDisposableTestDatabase(client,{...opts,confirmedStopped:false}),/REHEARSAL_PRECONDITIONS_REQUIRED/);
  await assert.rejects(r.rotateDisposableTestDatabase(client,opts),/WORKER_STILL_ACTIVE/);
  await client.query('UPDATE xc_auto_worker_health SET heartbeat_at=0 WHERE id=1');
  const rotated=await r.rotateDisposableTestDatabase(client,opts);
  assert.equal(rotated.mode,'test-only-rotation');
  assert.equal(rotated.counts.x_accounts.legacy,1);
  assert.deepEqual((await r.audit(client,opts)).counts,{x_accounts:{legacy:0,v2:1},xc_ai_providers:{legacy:0,v2:1}});
  const row=(await client.query<{session_encrypted:Buffer}>('SELECT session_encrypted FROM x_accounts')).rows[0];
  assert.equal(r.kind(row.session_encrypted),'v2');
  assert.throws(()=>r.unpack(row.session_encrypted,{legacyKey:oldKey}),/KEY_UNAVAILABLE/);
  const opened=r.unpack(row.session_encrypted,{legacyKey:oldKey,keys:{new_2026:newKey}});
  try{assert.match(opened.plaintext.toString('utf8'),/test-only/);}finally{opened.plaintext.fill(0);}
  // The first row is decrypted/re-encrypted, then a corrupted later row triggers a rollback.
  const invalid=Buffer.from('bad-ciphertext');
  await client.query("INSERT INTO xc_ai_providers(id,secret) VALUES('corrupt_ai',$1)",[invalid]);
  const before=(await client.query<{session_encrypted:Buffer}>('SELECT session_encrypted FROM x_accounts')).rows[0].session_encrypted;
  await assert.rejects(r.rotateDisposableTestDatabase(client,opts),/TEST_ROTATION_ROLLED_BACK/);
  const after=(await client.query<{session_encrypted:Buffer}>('SELECT session_encrypted FROM x_accounts')).rows[0].session_encrypted;
  assert.deepEqual(after,before,'No partial key migration after one invalid row');
  assert.equal((await client.query<{n:number}>('SELECT count(*)::int n FROM xc_ai_providers')).rows[0].n,2);
 }finally{
  oldKey.fill(0);newKey.fill(0);
  try{if(created){await client.query('RESET search_path');await client.query('DROP SCHEMA "'+schema+'" CASCADE');}}finally{await client.end().catch(()=>{});}
 }
});
