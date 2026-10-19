import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {randomBytes,createCipheriv} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
const load=createRequire(__filename);
const r=load('../scripts/autopost/key-rotation-core.cjs');
function legacy(plain:Buffer,key:Buffer){
 const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);
 return Buffer.concat([iv,c.getAuthTag(),Buffer.concat([c.update(plain),c.final()])]);
}
test('V2-07: v2 key-id is authenticated; legacy is readable with old key only',()=>{
 const old=randomBytes(32),next=randomBytes(32),plain=Buffer.from('{"cookies":[{"name":"ct0","value":"not-real"}]}');
 const previous=legacy(plain,old),v2=r.packV2(plain,'key2026',next);
 assert.equal(r.kind(previous),'legacy');assert.equal(r.kind(v2),'v2');
 assert.deepEqual(r.unpack(previous,{legacyKey:old}).plaintext,plain);
 assert.deepEqual(r.unpack(v2,{legacyKey:old,keys:{key2026:next}}).plaintext,plain);
 assert.throws(()=>r.unpack(previous,{legacyKey:next}),/DECRYPTION_FAILED/);
 assert.throws(()=>r.unpack(v2,{legacyKey:old,keys:{}}),/KEY_UNAVAILABLE/);
 const tampered=Buffer.from(v2);tampered[r.MAGIC.length+1]='x'.charCodeAt(0);
 assert.throws(()=>r.unpack(tampered,{legacyKey:old,keys:{key2026:next,xey2026:next}}),/DECRYPTION_FAILED/);
 assert.throws(()=>r.unpack(v2.subarray(0,16),{legacyKey:old,keys:{key2026:next}}),/INVALID_ENVELOPE/);
});
test('V2-07: strict keys and ciphertext validation',()=>{
 const key=randomBytes(32),plain=Buffer.from('secret-value');
 assert.deepEqual(r.parseKey(key.toString('hex')),key);
 assert.deepEqual(r.parseKey(key.toString('base64')),key);
 assert.throws(()=>r.parseKey('not-a-key'),/INVALID_KEY_FORMAT/);
 assert.throws(()=>r.packV2(plain,'bad:key',key),/INVALID_ENCRYPTION_ARGUMENT/);
 assert.throws(()=>r.validatePlaintext('x_accounts',plain),/INVALID_X_SESSION/);
 assert.throws(()=>r.validatePlaintext('xc_ai_providers',Buffer.alloc(0)),/INVALID_AI_KEY/);
});
test('V2-07: dry-run reads legacy X session and AI key without writes or returning secrets',async()=>{
 const db=new PGlite(),key=randomBytes(32);
 try{
  await db.exec('CREATE TABLE x_accounts(name text PRIMARY KEY,session_encrypted bytea);CREATE TABLE xc_ai_providers(id text PRIMARY KEY,secret bytea)');
  await db.query('INSERT INTO x_accounts(name,session_encrypted) VALUES($1,$2)', ['acct',legacy(Buffer.from('{"cookies":[{"name":"ct0"}]}'),key)]);
  await db.query('INSERT INTO xc_ai_providers(id,secret) VALUES($1,$2)',['provider',legacy(Buffer.from('very-secret-ai-key'),key)]);
  const c={query:(sql:string,p:unknown[]=[])=>db.query(sql,p)};
  const result=await r.audit(c,{legacyKey:key,batchSize:1});
  assert.deepEqual(result.counts,{x_accounts:{legacy:1,v2:0},xc_ai_providers:{legacy:1,v2:0}});
  assert.equal(JSON.stringify(result).includes('secret'),false);
  const pre=(await db.query<{secret:Uint8Array}>('SELECT secret FROM xc_ai_providers')).rows[0].secret;
  assert.equal(r.kind(Buffer.from(pre)),'legacy');
  await assert.rejects(r.rotateDisposableTestDatabase(c,{legacyKey:key,nextKey:randomBytes(32),nextId:'new',confirmedBackup:true,confirmedStopped:true}),/DISPOSABLE_TEST_DATABASE_REQUIRED/);
  const after=(await db.query<{secret:Uint8Array}>('SELECT secret FROM xc_ai_providers')).rows[0].secret;
  assert.deepEqual(after,pre);
 }finally{await db.close();}
});
test('V2-07: wrong legacy key fails closed; audited transaction cannot mutate records',async()=>{
 const db=new PGlite(),key=randomBytes(32);
 try{
  await db.exec('CREATE TABLE x_accounts(name text PRIMARY KEY,session_encrypted bytea);CREATE TABLE xc_ai_providers(id text PRIMARY KEY,secret bytea)');
  await db.query('INSERT INTO x_accounts(name,session_encrypted) VALUES($1,$2)',['acct',legacy(Buffer.from('{"cookies":[{}]}'),key)]);
  const c={query:(sql:string,p:unknown[]=[])=>db.query(sql,p)};
  await assert.rejects(r.audit(c,{legacyKey:randomBytes(32)}),/ROTATION_AUDIT_FAILED/);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM x_accounts')).rows[0].n,1);
 }finally{await db.close();}
});
