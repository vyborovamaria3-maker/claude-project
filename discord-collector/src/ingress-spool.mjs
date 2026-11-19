import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync,
  writeFileSync,
} from "node:fs";
import {createCipheriv,createDecipheriv,randomBytes} from "node:crypto";
import {join,resolve} from "node:path";
import {isDiscordSnowflake} from "@claude-project/contracts";

const FORMAT_VERSION=1;
const AAD_PREFIX="potapoff-discord-ingress-v1:";
const MAX_EVENT_BYTES=64*1024;
const DAY_MS=86_400_000;

function awareTimestamp(value,name,{required=false}={}){
  if(value===null||value===undefined){
    if(required)throw new TypeError(name+" is required");
    return null;
  }
  if(typeof value!=="string"||
     !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)||
     !Number.isFinite(Date.parse(value)))
    throw new TypeError(name+" must be an offset-aware ISO timestamp");
  return new Date(value).toISOString();
}

function validateEvent(input){
  if(!input||typeof input!=="object"||Array.isArray(input))
    throw new TypeError("Ingress event must be an object");
  const allowedKeys=new Set([
    "kind","messageId","guildId","channelId","authorId","content",
    "createdAt","editedAt","receivedAt",
  ]);
  if(Object.keys(input).some(key=>!allowedKeys.has(key)))
    throw new TypeError("Ingress event contains an unsupported field");
  if(!["observed","edited","deleted"].includes(input.kind))
    throw new TypeError("Invalid ingress event kind");
  for(const key of ["messageId","guildId","channelId"]){
    if(!isDiscordSnowflake(String(input[key]??"")))
      throw new TypeError("Invalid ingress "+key+" Snowflake");
  }
  const authorId=input.authorId===null||input.authorId===undefined?null:String(input.authorId);
  if(authorId&&!isDiscordSnowflake(authorId))throw new TypeError("Invalid ingress author Snowflake");
  const content=input.content===null||input.content===undefined?null:input.content;
  if(content!==null&&(typeof content!=="string"||Buffer.byteLength(content,"utf8")>20_000))
    throw new TypeError("Ingress message content exceeds its bounded format");
  if(input.kind==="deleted"&&content!==null)
    throw new TypeError("Deleted ingress events cannot retain message content");
  if(input.kind==="deleted"&&authorId!==null)
    throw new TypeError("Deleted ingress events cannot retain author identifiers");
  const createdAt=awareTimestamp(input.createdAt,"createdAt");
  if(!createdAt&&(content!==null||authorId!==null))
    throw new TypeError("Ingress content and author identifiers require a source publication timestamp");
  return Object.freeze({
    kind:input.kind,
    messageId:String(input.messageId),
    guildId:String(input.guildId),
    channelId:String(input.channelId),
    authorId,
    content,
    createdAt,
    editedAt:awareTimestamp(input.editedAt,"editedAt"),
    receivedAt:awareTimestamp(input.receivedAt,"receivedAt",{required:true}),
  });
}

export function parseIngressSpoolKey(encoded){
  if(typeof encoded!=="string"||! /^[A-Za-z0-9+/]{43}=$/.test(encoded))
    throw new TypeError("DISCORD_INGRESS_SPOOL_KEY must be a canonical base64-encoded 32-byte key");
  const key=Buffer.from(encoded,"base64");
  if(key.length!==32||key.toString("base64")!==encoded)
    throw new TypeError("DISCORD_INGRESS_SPOOL_KEY must decode to exactly 32 bytes");
  return key;
}

function encryptRecord(sequence,event,key){
  const iv=randomBytes(12);
  const cipher=createCipheriv("aes-256-gcm",key,iv);
  cipher.setAAD(Buffer.from(AAD_PREFIX+sequence));
  const ciphertext=Buffer.concat([
    cipher.update(JSON.stringify(event),"utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    version:FORMAT_VERSION,
    sequence,
    iv:iv.toString("base64"),
    tag:cipher.getAuthTag().toString("base64"),
    ciphertext:ciphertext.toString("base64"),
  })+"\n";
}

function decryptRecord(raw,expectedSequence,key){
  let envelope;
  try{envelope=JSON.parse(raw)}
  catch{throw new Error("Ingress spool contains malformed JSON; refusing to discard a possibly received event")}
  if(!envelope||envelope.version!==FORMAT_VERSION||
     envelope.sequence!==expectedSequence||
     typeof envelope.iv!=="string"||typeof envelope.tag!=="string"||
     typeof envelope.ciphertext!=="string")
    throw new Error("Ingress spool record header is invalid");
  try{
    const iv=Buffer.from(envelope.iv,"base64");
    const tag=Buffer.from(envelope.tag,"base64");
    const ciphertext=Buffer.from(envelope.ciphertext,"base64");
    if(iv.length!==12||tag.length!==16||ciphertext.length===0)
      throw new Error("invalid encrypted record lengths");
    const decipher=createDecipheriv("aes-256-gcm",key,iv);
    decipher.setAAD(Buffer.from(AAD_PREFIX+expectedSequence));
    decipher.setAuthTag(tag);
    const plaintext=Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString("utf8");
    return validateEvent(JSON.parse(plaintext));
  }catch{
    throw new Error("Ingress spool authentication or event validation failed; refusing to continue");
  }
}

export class IngressSpool {
  constructor({directory,key,maxBytes=512*1024*1024,maxEvents=100_000}){
    if(typeof directory!=="string"||!directory.trim())
      throw new TypeError("An explicit DISCORD_INGRESS_SPOOL_DIR is required");
    if(!Buffer.isBuffer(key)||key.length!==32)
      throw new TypeError("Ingress spool requires a 32-byte encryption key");
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1)
      throw new RangeError("Ingress spool maxBytes must be a positive safe integer");
    if(!Number.isSafeInteger(maxEvents)||maxEvents<1)
      throw new RangeError("Ingress spool maxEvents must be a positive safe integer");
    this.directory=resolve(directory);
    this.key=Buffer.from(key);
    this.maxBytes=maxBytes;
    this.maxEvents=maxEvents;
    this.pending=new Map();
    this.pendingBytes=0;
    this.nextSequence=1n;
    this.directoryFd=null;
    this.opened=false;
    this.ackDirty=false;
  }

  open(){
    if(this.opened)throw new Error("Ingress spool is already open");
    mkdirSync(this.directory,{recursive:true,mode:0o700});
    const initial=lstatSync(this.directory);
    if(initial.isSymbolicLink()||!initial.isDirectory())
      throw new Error("Ingress spool path must be a real directory, not a symlink");
    chmodSync(this.directory,0o700);
    const secured=lstatSync(this.directory);
    if((secured.mode&0o777)!==0o700)
      throw new Error("Ingress spool directory permissions must be exactly 0700");
    if(typeof process.getuid==="function"&&secured.uid!==process.getuid())
      throw new Error("Ingress spool directory must be owned by the collector user");
    this.directoryFd=openSync(this.directory,"r");
    try{
      let sawTemporary=false;
      for(const name of readdirSync(this.directory).sort()){
        const match=/^([0-9]{20})\.(evt|tmp)$/.exec(name);
        if(!match)throw new Error("Unexpected file in dedicated ingress spool directory: "+name);
        const paddedSequence=match[1];
        const sequence=BigInt(paddedSequence).toString();
        if(sequence==="0")throw new Error("Ingress spool sequence zero is invalid");
        const path=join(this.directory,name);
        const stat=lstatSync(path);
        if(stat.isSymbolicLink()||!stat.isFile())
          throw new Error("Ingress spool records must be regular files, not symlinks");
        chmodSync(path,0o600);
        const securedFile=lstatSync(path);
        if((securedFile.mode&0o777)!==0o600)
          throw new Error("Ingress spool records must have exact mode 0600");
        if(typeof process.getuid==="function"&&securedFile.uid!==process.getuid())
          throw new Error("Ingress spool records must be owned by the collector user");
        if(securedFile.size<1||securedFile.size>MAX_EVENT_BYTES)
          throw new Error("Ingress spool record has an invalid size; refusing to discard it");
        decryptRecord(readFileSync(path,"utf8"),sequence,this.key); // Authenticate before Gateway login.
        if(this.pending.has(sequence))throw new Error("Duplicate ingress spool sequence");
        if(match[2]==="tmp"){
          const target=join(this.directory,paddedSequence+".evt");
          if(existsSync(target))throw new Error("Ingress spool temporary/final record collision");
          renameSync(path,target);
          sawTemporary=true;
        }
        const finalPath=join(this.directory,paddedSequence+".evt");
        const finalStat=statSync(finalPath);
        this.pending.set(sequence,{sequence,path:finalPath,size:finalStat.size});
        this.pendingBytes+=finalStat.size;
        const next=BigInt(sequence)+1n;
        if(next>this.nextSequence)this.nextSequence=next;
      }
      if(sawTemporary)fsyncSync(this.directoryFd);
      fsyncSync(this.directoryFd);
      // Existing durable backlog is always allowed to open so it can be drained
      // before Gateway reconnect. Capacity limits apply to new appends only.
      this.opened=true;
      return this;
    }catch(error){
      closeSync(this.directoryFd);
      this.directoryFd=null;
      this.key.fill(0);
      throw error;
    }
  }

  append(input){
    if(!this.opened)throw new Error("Ingress spool is not open");
    const event=validateEvent(input);
    const sequence=this.nextSequence.toString();
    const padded=sequence.padStart(20,"0");
    if(padded.length!==20)throw new RangeError("Ingress spool sequence exhausted");
    const encoded=encryptRecord(sequence,event,this.key);
    const size=Buffer.byteLength(encoded,"utf8");
    if(size>MAX_EVENT_BYTES)throw new RangeError("Ingress event exceeds the maximum encrypted record size");
    if(this.pending.size+1>this.maxEvents||this.pendingBytes+size>this.maxBytes){
      const error=new Error("Durable Discord ingress spool capacity exhausted");
      error.code="INGRESS_SPOOL_FULL";
      throw error;
    }
    const temporary=join(this.directory,padded+".tmp");
    const finalPath=join(this.directory,padded+".evt");
    const fd=openSync(temporary,"wx",0o600);
    try{
      writeFileSync(fd,encoded,{encoding:"utf8"});
      fsyncSync(fd);
    }finally{closeSync(fd)}
    renameSync(temporary,finalPath);
    const entry={sequence,path:finalPath,size};
    this.pending.set(sequence,entry);
    this.pendingBytes+=size;
    this.nextSequence++;
    // The Gateway callback returns only after both file data and directory entry
    // have been flushed. A crash after this point replays the durable event.
    fsyncSync(this.directoryFd);
    return {sequence,event};
  }

  listPending(limit=Number.MAX_SAFE_INTEGER){
    if(!this.opened)throw new Error("Ingress spool is not open");
    if(!Number.isSafeInteger(limit)||limit<1)throw new RangeError("Invalid ingress spool page size");
    // Map insertion order is sequence order: startup inserts sorted filenames,
    // and new events are appended with monotonically increasing sequence IDs.
    return [...this.pending.values()].slice(0,limit).map(entry=>({
      ...entry,
      event:decryptRecord(readFileSync(entry.path,"utf8"),entry.sequence,this.key),
    }));
  }

  ack(sequence){
    if(!this.opened)throw new Error("Ingress spool is not open");
    const key=String(sequence);
    const entry=this.pending.get(key);
    if(!entry)return false;
    try{unlinkSync(entry.path)}
    catch(error){if(error.code!=="ENOENT")throw error}
    this.pending.delete(key);
    this.pendingBytes=Math.max(0,this.pendingBytes-entry.size);
    this.ackDirty=true;
    return true;
  }

  flushAcks(){
    if(!this.opened||!this.ackDirty)return;
    fsyncSync(this.directoryFd);
    this.ackDirty=false;
  }

  sweepExpired(allowed,now=new Date()){
    if(!this.opened)throw new Error("Ingress spool is not open");
    if(!(allowed instanceof Map))throw new TypeError("Current channel allowlist is required");
    let erased=0;
    const nowMs=now.getTime();
    for(const entry of this.pending.values()){
      // Decrypt one record at a time; never retain the whole backlog's raw text
      // and author identifiers in process memory.
      const event=decryptRecord(readFileSync(entry.path,"utf8"),entry.sequence,this.key);
      const permission=allowed.get(event.channelId);
      const revoked=!permission||permission.guildId!==event.guildId;
      const published=event.createdAt?Date.parse(event.createdAt):null;
      const expired=!revoked&&event.kind!=="deleted"&&published!==null&&
        published<nowMs-permission.retentionDays*DAY_MS;
      if(revoked||expired){
        this.ack(entry.sequence);
        erased++;
      }
    }
    this.flushAcks();
    return {eventsErased:erased,pendingEvents:this.pending.size,pendingBytes:this.pendingBytes};
  }

  get pendingCount(){return this.pending.size}

  get oldestPending(){return this.listPending(1)[0]??null}

  close(){
    if(!this.opened)return;
    try{this.flushAcks()}
    finally{
      closeSync(this.directoryFd);
      this.directoryFd=null;
      this.opened=false;
      this.key.fill(0);
    }
  }
}
