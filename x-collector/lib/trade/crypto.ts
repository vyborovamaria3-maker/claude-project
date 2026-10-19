import {createCipheriv,createDecipheriv,randomBytes} from "node:crypto";

// Same AES-256-GCM envelope as scripts/autopost/key-rotation-core.cjs.
// Written in TypeScript so compiled dist and tsx can both load this module.
const MAGIC=Buffer.from("XCKEYV2!","ascii");
const ID=/^[A-Za-z0-9_-]{1,48}$/;
const KEY_BYTES=32,IV_BYTES=12,TAG_BYTES=16;
function parseKey(raw:string):Buffer {
 if(!raw)throw Error("KEY_UNAVAILABLE");
 if(!/^[0-9a-fA-F]{64}$/.test(raw)&&!/^[A-Za-z0-9+/]{42}[A-Za-z0-9+/=]{2}$/.test(raw))
  throw Error("INVALID_KEY_FORMAT");
 const k=Buffer.from(raw,/^[0-9a-fA-F]{64}$/.test(raw)?"hex":"base64");
 if(k.length!==KEY_BYTES){k.fill(0);throw Error("INVALID_KEY_LENGTH");}
 return k;
}
function configuredKeys():{legacyKey:Buffer;keys:Record<string,Buffer>;active:string|null}{
 const legacyKey=parseKey(process.env.MASTER_KEY||process.env.X_COLLECTOR_MASTER_KEY||"");
 const keys:Record<string,Buffer>=Object.create(null);
 try{
  const raw=process.env.X_COLLECTOR_ENCRYPTION_KEYS;
  if(raw){
   let parsed:unknown;
   try{parsed=JSON.parse(raw);}catch{throw Error("INVALID_KEYRING_JSON");}
   if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||Object.keys(parsed).length>16)
    throw Error("INVALID_KEYRING_JSON");
   for(const [id,value] of Object.entries(parsed)){
    if(!ID.test(id)||typeof value!=="string")throw Error("INVALID_KEYRING_ENTRY");
    keys[id]=parseKey(value);
   }
  }
  const active=process.env.X_COLLECTOR_ACTIVE_KEY_ID||null;
  if(active!==null&&(!ID.test(active)||!keys[active]))throw Error("ACTIVE_KEY_UNAVAILABLE");
  return {legacyKey,keys,active};
 }catch(error){legacyKey.fill(0);Object.values(keys).forEach(k=>k.fill(0));throw error;}
}
function erase(ring:{legacyKey:Buffer;keys:Record<string,Buffer>}):void{
 ring.legacyKey.fill(0);Object.values(ring.keys).forEach(k=>k.fill(0));
}
function legacyEncrypt(plain:Buffer,key:Buffer):Buffer{
 const iv=randomBytes(IV_BYTES),c=createCipheriv("aes-256-gcm",key,iv);
 const data=Buffer.concat([c.update(plain),c.final()]);
 return Buffer.concat([iv,c.getAuthTag(),data]);
}
function versionedEncrypt(plain:Buffer,id:string,key:Buffer):Buffer{
 const header=Buffer.concat([MAGIC,Buffer.from([id.length]),Buffer.from(id,"ascii")]);
 const iv=randomBytes(IV_BYTES),c=createCipheriv("aes-256-gcm",key,iv);
 c.setAAD(header);
 const data=Buffer.concat([c.update(plain),c.final()]);
 return Buffer.concat([header,iv,c.getAuthTag(),data]);
}
export function decryptBufferWithKeys(blob:Buffer,legacyKey:Buffer,keys:Record<string,Buffer>={}):Buffer{
 if(!Buffer.isBuffer(blob)||blob.length<IV_BYTES+TAG_BYTES+1)throw Error("INVALID_ENVELOPE");
 let key=legacyKey,header:Buffer|undefined,offset=0;
 if(blob.subarray(0,MAGIC.length).equals(MAGIC)){
  const len=blob[MAGIC.length];
  if(!Number.isInteger(len)||len<1||len>48)throw Error("INVALID_KEY_ID");
  offset=MAGIC.length+1+len;
  if(blob.length<offset+IV_BYTES+TAG_BYTES+1)throw Error("INVALID_ENVELOPE");
  const id=blob.subarray(MAGIC.length+1,offset).toString("ascii");
  if(!ID.test(id))throw Error("INVALID_KEY_ID");
  key=keys[id];header=blob.subarray(0,offset);
 }
 if(!Buffer.isBuffer(key)||key.length!==KEY_BYTES)throw Error("KEY_UNAVAILABLE");
 try{
  const d=createDecipheriv("aes-256-gcm",key,blob.subarray(offset,offset+IV_BYTES));
  if(header)d.setAAD(header);
  d.setAuthTag(blob.subarray(offset+IV_BYTES,offset+IV_BYTES+TAG_BYTES));
  return Buffer.concat([d.update(blob.subarray(offset+IV_BYTES+TAG_BYTES)),d.final()]);
 }catch{throw Error("DECRYPTION_FAILED");}
}
// Historical export, but keys are intentionally loaded fresh per operation.
export function clearKeyCache():void {}
export function encryptBuffer(plain:Buffer):Buffer{
 const ring=configuredKeys();
 try{return ring.active?versionedEncrypt(plain,ring.active,ring.keys[ring.active]):legacyEncrypt(plain,ring.legacyKey);}
 finally{erase(ring);}
}
export function decryptBuffer(blob:Buffer):Buffer{
 const ring=configuredKeys();
 try{return decryptBufferWithKeys(blob,ring.legacyKey,ring.keys);}
 finally{erase(ring);}
}
