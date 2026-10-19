import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {decryptBuffer,encryptBuffer,decryptBufferWithKeys,clearKeyCache} from '../lib/trade/crypto';
import {decryptSession} from '../src/x/session';
const load=createRequire(__filename);
const cjs=load('../scripts/autopost/keyring.cjs');
const core=load('../scripts/autopost/key-rotation-core.cjs');
const tracked=['MASTER_KEY','X_COLLECTOR_MASTER_KEY','X_COLLECTOR_ENCRYPTION_KEYS','X_COLLECTOR_ACTIVE_KEY_ID'] as const;
async function withEnv(vars:Record<string,string|undefined>,fn:()=>Promise<void>|void){
 const previous=Object.fromEntries(tracked.map(k=>[k,process.env[k]]));
 try{
  for(const k of tracked)delete process.env[k];
  for(const [key,value] of Object.entries(vars))if(value!==undefined)process.env[key]=value;
  await fn();
 }finally{
  for(const k of tracked){
   if(previous[k]===undefined)delete process.env[k];
   else process.env[k]=previous[k];
  }
  clearKeyCache();
 }
}
test('V2-07: TypeScript readers handle CJS legacy and v2 ciphertext',async()=>{
 const old=randomBytes(32),future=randomBytes(32);
 const vars={MASTER_KEY:old.toString('hex'),X_COLLECTOR_ENCRYPTION_KEYS:JSON.stringify({future:future.toString('base64')}),X_COLLECTOR_ACTIVE_KEY_ID:'future'};
 await withEnv(vars,()=>{
  const plain=Buffer.from('{"cookies":[{"name":"ct0","value":"offline-test"}]}');
  const modern=cjs.sealBytes(plain,vars);
  assert.equal(core.kind(modern),'v2');
  assert.deepEqual(decryptBuffer(modern),plain);
  assert.equal(decryptSession(modern,old,{future}),plain.toString('utf8'));
  const previous=cjs.sealBytes(plain,{MASTER_KEY:old.toString('hex')});
  assert.equal(core.kind(previous),'legacy');
  assert.deepEqual(decryptBuffer(previous),plain);
  assert.equal(decryptSession(previous,old),plain.toString('utf8'));
  assert.throws(()=>decryptBufferWithKeys(modern,old),/KEY_UNAVAILABLE/);
  assert.throws(()=>decryptBufferWithKeys(previous,future),/DECRYPTION_FAILED/);
 });
});
test('V2-07: CJS readers handle TypeScript legacy and v2 ciphertext',async()=>{
 const old=randomBytes(32),future=randomBytes(32);
 const vars={MASTER_KEY:old.toString('hex'),X_COLLECTOR_ENCRYPTION_KEYS:JSON.stringify({next_2026:future.toString('hex')}),X_COLLECTOR_ACTIVE_KEY_ID:'next_2026'};
 await withEnv(vars,()=>{
  const plain=Buffer.from('test-only-token');
  const modern=encryptBuffer(plain);
  assert.equal(core.kind(modern),'v2');
  assert.deepEqual(cjs.unsealBytes(modern,vars),plain);
  delete process.env.X_COLLECTOR_ACTIVE_KEY_ID;
  const previous=encryptBuffer(plain);
  assert.equal(core.kind(previous),'legacy','Default writes must remain legacy');
  assert.deepEqual(cjs.unsealBytes(previous,vars),plain);
  assert.deepEqual(decryptBuffer(modern),plain);
 });
});
test('V2-07: unknown ID, missing key and tampered headers fail closed',async()=>{
 const old=randomBytes(32),future=randomBytes(32),plain=Buffer.from('no real credentials');
 const vars={MASTER_KEY:old.toString('hex'),X_COLLECTOR_ENCRYPTION_KEYS:JSON.stringify({future:future.toString('hex')}),X_COLLECTOR_ACTIVE_KEY_ID:'future'};
 await withEnv(vars,()=>{
  const valid=encryptBuffer(plain),edited=Buffer.from(valid);
  edited[core.MAGIC.length+1]^=1;
  assert.throws(()=>decryptBuffer(edited),/DECRYPTION_FAILED|KEY_UNAVAILABLE|INVALID_KEY_ID/);
  assert.throws(()=>cjs.unsealBytes(edited,vars),/DECRYPTION_FAILED|KEY_UNAVAILABLE|INVALID_KEY_ID/);
  delete process.env.X_COLLECTOR_ENCRYPTION_KEYS;
  assert.throws(()=>decryptBuffer(valid),/ACTIVE_KEY_UNAVAILABLE/);
  delete process.env.X_COLLECTOR_ACTIVE_KEY_ID;
  assert.throws(()=>decryptBuffer(valid),/KEY_UNAVAILABLE/);
  assert.equal(core.kind(encryptBuffer(plain)),'legacy');
 });
});
