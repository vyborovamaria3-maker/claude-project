'use strict';
const nodeCrypto=require('node:crypto');
const {parseKey,packV2,unpack}=require('./key-rotation-core.cjs');
const ID=/^[A-Za-z0-9_-]{1,48}$/;
function loadKeyring(env){
 if(!env||typeof env!=='object')throw Error('INVALID_KEYRING_ENV');
 const legacyKey=parseKey(env.MASTER_KEY||env.X_COLLECTOR_MASTER_KEY||'');
 const keys=Object.create(null);
 try{
  const raw=env.X_COLLECTOR_ENCRYPTION_KEYS;
  if(raw){
   let parsed;try{parsed=JSON.parse(raw);}catch{throw Error('INVALID_KEYRING_JSON');}
   if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed).length>16)throw Error('INVALID_KEYRING_JSON');
   for(const [id,value] of Object.entries(parsed)){
    if(!ID.test(id)||typeof value!=='string')throw Error('INVALID_KEYRING_ENTRY');
    keys[id]=parseKey(value);
   }
  }
  const active=env.X_COLLECTOR_ACTIVE_KEY_ID||null;
  if(active!==null&&(!ID.test(active)||!keys[active]))throw Error('ACTIVE_KEY_UNAVAILABLE');
  return {legacyKey,keys,active};
 }catch(error){legacyKey.fill(0);Object.values(keys).forEach(k=>k.fill(0));throw error;}
}
function clearKeyring(ring){
 ring.legacyKey?.fill(0);
 for(const k of Object.values(ring.keys||{}))k.fill(0);
}
function sealBytes(plain,env){
 if(!Buffer.isBuffer(plain))throw Error('INVALID_PLAINTEXT');
 const ring=loadKeyring(env);
 try{
  if(ring.active)return packV2(plain,ring.active,ring.keys[ring.active]);
  const iv=nodeCrypto.randomBytes(12),cipher=nodeCrypto.createCipheriv('aes-256-gcm',ring.legacyKey,iv);
  const body=Buffer.concat([cipher.update(plain),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),body]);
 }finally{clearKeyring(ring);}
}
function unsealBytes(blob,env){
 const ring=loadKeyring(env);
 try{return unpack(blob,{legacyKey:ring.legacyKey,keys:ring.keys}).plaintext;}
 finally{clearKeyring(ring);}
}
module.exports={loadKeyring,clearKeyring,sealBytes,unsealBytes};
