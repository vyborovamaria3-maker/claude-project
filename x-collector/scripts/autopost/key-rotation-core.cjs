'use strict';
// Versioned envelope; production key rotation still requires separate approval.
const nodeCrypto=require('node:crypto');
const MAGIC=Buffer.from('XCKEYV2!','ascii');
const ID_PATTERN=/^[A-Za-z0-9_-]{1,48}$/;
const KEY_BYTES=32, IV_BYTES=12, TAG_BYTES=16;
function parseKey(input){
 if(typeof input!=='string'||!input)throw Error('KEY_UNAVAILABLE');
 let key;
 if(/^[0-9a-fA-F]{64}$/.test(input))key=Buffer.from(input,'hex');
 else if(/^[A-Za-z0-9+/]{42}[A-Za-z0-9+/=]{2}$/.test(input))key=Buffer.from(input,'base64');
 else throw Error('INVALID_KEY_FORMAT');
 if(key.length!==KEY_BYTES){key.fill(0);throw Error('INVALID_KEY_LENGTH');}
 return key;
}
function kind(blob){
 if(!Buffer.isBuffer(blob)||blob.length<IV_BYTES+TAG_BYTES+1)throw Error('INVALID_ENVELOPE');
 return blob.subarray(0,MAGIC.length).equals(MAGIC)?'v2':'legacy';
}
function packV2(plaintext,keyId,key){
 if(!Buffer.isBuffer(plaintext)||!ID_PATTERN.test(keyId)||!Buffer.isBuffer(key)||key.length!==KEY_BYTES)throw Error('INVALID_ENCRYPTION_ARGUMENT');
 const id=Buffer.from(keyId,'ascii'),header=Buffer.concat([MAGIC,Buffer.from([id.length]),id]);
 const iv=nodeCrypto.randomBytes(IV_BYTES);
 const cipher=nodeCrypto.createCipheriv('aes-256-gcm',key,iv);
 cipher.setAAD(header);
 const body=Buffer.concat([cipher.update(plaintext),cipher.final()]);
 return Buffer.concat([header,iv,cipher.getAuthTag(),body]);
}
function unpack(blob,{legacyKey,keys={}}){
 const format=kind(blob);
 let key,iv,tag,body,header;
 if(format==='legacy'){
  key=legacyKey;iv=blob.subarray(0,IV_BYTES);
  tag=blob.subarray(IV_BYTES,IV_BYTES+TAG_BYTES);
  body=blob.subarray(IV_BYTES+TAG_BYTES);
 }else{
  const len=blob[MAGIC.length];
  if(!Number.isInteger(len)||len<1||len>48)throw Error('INVALID_KEY_ID');
  const offset=MAGIC.length+1+len;
  if(blob.length<offset+IV_BYTES+TAG_BYTES+1)throw Error('INVALID_ENVELOPE');
  const id=blob.subarray(MAGIC.length+1,offset).toString('ascii');
  if(!ID_PATTERN.test(id))throw Error('INVALID_KEY_ID');
  key=keys[id];header=blob.subarray(0,offset);
  iv=blob.subarray(offset,offset+IV_BYTES);
  tag=blob.subarray(offset+IV_BYTES,offset+IV_BYTES+TAG_BYTES);
  body=blob.subarray(offset+IV_BYTES+TAG_BYTES);
 }
 if(!Buffer.isBuffer(key)||key.length!==KEY_BYTES)throw Error('KEY_UNAVAILABLE');
 try{
  const decipher=nodeCrypto.createDecipheriv('aes-256-gcm',key,iv);
  if(header)decipher.setAAD(header);
  decipher.setAuthTag(tag);
  return {format,plaintext:Buffer.concat([decipher.update(body),decipher.final()])};
 }catch{throw Error('DECRYPTION_FAILED');}
}
function validatePlaintext(table,plain){
 if(table==='x_accounts'){
  let json;
  try{json=JSON.parse(plain.toString('utf8'));}catch{throw Error('INVALID_X_SESSION');}
  const cookies=Array.isArray(json)?json:json?.cookies;
  if(!Array.isArray(cookies)||!cookies.length)throw Error('INVALID_X_SESSION');
  return;
 }
 if(table==='xc_ai_providers'){
  if(!plain.length||plain.includes(0))throw Error('INVALID_AI_KEY');
  return;
 }
 throw Error('UNKNOWN_SECRET_TABLE');
}
const SOURCES=[
 {table:'x_accounts',id:'name',column:'session_encrypted'},
 {table:'xc_ai_providers',id:'id',column:'secret'},
];
async function scan(c,{legacyKey,keys={},nextKey=null,nextId=null,apply=false,batchSize=100}){
 if(!Buffer.isBuffer(legacyKey)||legacyKey.length!==KEY_BYTES)throw Error('LEGACY_KEY_REQUIRED');
 if(apply&&(!ID_PATTERN.test(nextId)||!Buffer.isBuffer(nextKey)||nextKey.length!==KEY_BYTES))throw Error('NEW_KEY_REQUIRED');
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>1000)throw Error('INVALID_BATCH_SIZE');
 const totals={x_accounts:{legacy:0,v2:0},xc_ai_providers:{legacy:0,v2:0}};
 // No plaintext, session, decrypted key, row identifier or encrypted blob in result or logs.
 for(const source of SOURCES){
  let cursor='';
  while(true){
   const sql=`SELECT ${source.id},${source.column} FROM ${source.table} WHERE ${source.id}>$1 AND ${source.column} IS NOT NULL ORDER BY ${source.id} LIMIT $2`;
   const rows=(await c.query(sql,[cursor,batchSize])).rows;
   if(!rows.length)break;
   for(const row of rows){
    const input=Buffer.from(row[source.column]);
    let plaintext;
    try{
     const opened=unpack(input,{legacyKey,keys});
     plaintext=opened.plaintext;
     validatePlaintext(source.table,plaintext);
     totals[source.table][opened.format]++;
     if(apply){
      const rewritten=packV2(plaintext,nextId,nextKey);
      try{
       const check=unpack(rewritten,{legacyKey,keys:{...keys,[nextId]:nextKey}});
       try{validatePlaintext(source.table,check.plaintext);}finally{check.plaintext.fill(0);}
       await c.query(`UPDATE ${source.table} SET ${source.column}=$1 WHERE ${source.id}=$2`,[rewritten,row[source.id]]);
      }finally{rewritten.fill(0);}
     }
    }finally{plaintext?.fill(0);input.fill(0);}
   }
   cursor=String(rows.at(-1)[source.id]);
   if(rows.length<batchSize)break;
  }
 }
 return {mode:apply?'test-only-rotation':'read-only-inventory',counts:totals};
}
async function audit(c,options){
 await c.query('BEGIN TRANSACTION READ ONLY');
 try{const result=await scan(c,{...options,apply:false});await c.query('COMMIT');return result;}
 catch{await c.query('ROLLBACK').catch(()=>{});throw Error('ROTATION_AUDIT_FAILED');}
}
async function rotateDisposableTestDatabase(c,options){
 if(options?.confirmedBackup!==true||options?.confirmedStopped!==true)throw Error('REHEARSAL_PRECONDITIONS_REQUIRED');
 const name=(await c.query('SELECT current_database() AS name')).rows[0]?.name;
 if(typeof name!=='string'||!name.endsWith('_test'))throw Error('DISPOSABLE_TEST_DATABASE_REQUIRED');
 // A signed operator checkbox does not replace a live-worker safety check.
 const present=(await c.query("SELECT to_regclass('xc_auto_worker_health') AS present")).rows[0]?.present;
 if(present){
  const current=(await c.query('SELECT heartbeat_at FROM xc_auto_worker_health WHERE id=1')).rows[0];
  const last=Number(current?.heartbeat_at);
  if(Number.isFinite(last)&&last>0&&Date.now()-last<120_000)throw Error('WORKER_STILL_ACTIVE');
 }
 await c.query('BEGIN');
 try{
  await c.query('SELECT pg_advisory_xact_lock(742098537)');
  await c.query('LOCK TABLE x_accounts,xc_ai_providers IN ACCESS EXCLUSIVE MODE');
  const report=await scan(c,{...options,apply:true});
  await c.query('COMMIT');
  return report;
 }catch{await c.query('ROLLBACK').catch(()=>{});throw Error('TEST_ROTATION_ROLLED_BACK');}
}
module.exports={MAGIC,parseKey,kind,packV2,unpack,validatePlaintext,scan,audit,rotateDisposableTestDatabase};
