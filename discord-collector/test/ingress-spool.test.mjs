import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeFileSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import {IngressSpool,parseIngressSpoolKey} from "../src/ingress-spool.mjs";

const guildId="123456789012345678";
const channelId="223456789012345678";
const otherChannelId="323456789012345678";
const messageId="423456789012345678";
const authorId="523456789012345678";
const event=(overrides={})=>({
  kind:"observed",messageId,guildId,channelId,authorId,
  content:"private Discord text: Solana mint candidate",
  createdAt:"2026-11-18T12:00:00.000Z",
  editedAt:null,
  receivedAt:"2026-11-19T12:00:00.000Z",
  ...overrides,
});
function fixture(options={}){
  const directory=mkdtempSync(join(tmpdir(),"potapoff-discord-spool-"));
  const key=randomBytes(32);
  const spool=new IngressSpool({directory,key,...options}).open();
  return {directory,key,spool,cleanup(){try{spool.close()}catch{}rmSync(directory,{recursive:true,force:true})}};
}

test("ingress spool encrypts events and replays them after process restart",()=>{
  const f=fixture();
  try{
    const appended=f.spool.append(event());
    assert.equal(appended.sequence,"1");
    assert.equal(f.spool.pendingCount,1);
    const [name]=readdirSync(f.directory);
    assert.equal(name,"00000000000000000001.evt");
    const raw=readFileSync(join(f.directory,name),"utf8");
    assert.equal(raw.includes("private Discord text"),false);
    assert.equal(raw.includes(authorId),false);
    assert.equal(raw.includes(messageId),false);
    assert.equal(statSync(f.directory).mode&0o777,0o700);
    assert.equal(statSync(join(f.directory,name)).mode&0o777,0o600);
    f.spool.close();
    const reopened=new IngressSpool({directory:f.directory,key:f.key}).open();
    try{
      const [pending]=reopened.listPending();
      assert.equal(pending.sequence,"1");
      assert.equal(pending.event.content,event().content);
      assert.equal(pending.event.authorId,authorId);
      assert.equal(reopened.ack("1"),true);
      reopened.flushAcks();
      assert.equal(reopened.pendingCount,0);
      assert.equal(readdirSync(f.directory).length,0);
    }finally{reopened.close()}
  }finally{f.cleanup()}
});

test("valid fsynced temporary records are recovered after a crash before rename",()=>{
  const f=fixture();
  try{
    f.spool.append(event());
    f.spool.close();
    const finalPath=join(f.directory,"00000000000000000001.evt");
    renameSync(finalPath,join(f.directory,"00000000000000000001.tmp"));
    const recovered=new IngressSpool({directory:f.directory,key:f.key}).open();
    try{
      assert.equal(recovered.pendingCount,1);
      assert.equal(readdirSync(f.directory)[0],"00000000000000000001.evt");
      assert.equal(recovered.listPending()[0].event.messageId,messageId);
    }finally{recovered.close()}
  }finally{f.cleanup()}
});

test("partial or corrupt temporary records fail closed instead of being silently discarded",()=>{
  const f=fixture();
  try{
    f.spool.close();
    const path=join(f.directory,"00000000000000000001.tmp");
    writeFileSync(path,"{partial",{mode:0o600});
    assert.throws(()=>new IngressSpool({directory:f.directory,key:f.key}).open(),/malformed JSON|authentication|record header/i);
    assert.equal(readdirSync(f.directory).includes("00000000000000000001.tmp"),true);
  }finally{f.cleanup()}
});


test("tampered ciphertext is rejected by authenticated encryption",()=>{
  const f=fixture();
  try{
    f.spool.append(event());
    f.spool.close();
    const path=join(f.directory,"00000000000000000001.evt");
    const record=JSON.parse(readFileSync(path,"utf8"));
    record.ciphertext=record.ciphertext.slice(0,-4)+"AAAA";
    writeFileSync(path,JSON.stringify(record)+"\n",{mode:0o600});
    assert.throws(()=>new IngressSpool({directory:f.directory,key:f.key}).open(),/authentication/i);
  }finally{f.cleanup()}
});

test("a different spool key cannot decrypt persisted events",()=>{
  const f=fixture();
  try{
    f.spool.append(event());
    f.spool.close();
    assert.throws(()=>new IngressSpool({
      directory:f.directory,key:randomBytes(32),
    }).open(),/authentication/i);
  }finally{f.cleanup()}
});

test("capacity limits apply backpressure without dropping the already durable event",()=>{
  const f=fixture({maxBytes:100_000,maxEvents:1});
  try{
    f.spool.append(event());
    assert.throws(()=>f.spool.append(event({messageId:"623456789012345678"})),
      error=>error.code==="INGRESS_SPOOL_FULL");
    assert.equal(f.spool.pendingCount,1);
    assert.equal(f.spool.listPending()[0].event.messageId,messageId);
  }finally{f.cleanup()}
});

test("retention and channel revocation erase pending encrypted events",()=>{
  const f=fixture();
  try{
    f.spool.append(event({createdAt:"2020-01-01T00:00:00.000Z"}));
    f.spool.append(event({messageId:"723456789012345678",channelId:otherChannelId}));
    const allowed=new Map([[channelId,{guildId,retentionDays:30}]]);
    const result=f.spool.sweepExpired(allowed,new Date("2026-11-19T12:00:00.000Z"));
    assert.deepEqual(result,{eventsErased:2,pendingEvents:0,pendingBytes:0});
    assert.equal(readdirSync(f.directory).length,0);
  }finally{f.cleanup()}
});

test("invalid event identifiers, content bounds, timestamps and extra fields are rejected",()=>{
  const f=fixture();
  try{
    assert.throws(()=>f.spool.append(event({messageId:"123"})),/Snowflake/i);
    assert.throws(()=>f.spool.append(event({content:"x".repeat(20_001)})),/content/i);
    assert.throws(()=>f.spool.append(event({receivedAt:"2026-11-19T12:00:00"})),/timestamp/i);
    assert.throws(()=>f.spool.append({...event(),rawGatewayPayload:{}}),/unsupported field/i);
    assert.throws(()=>f.spool.append(event({kind:"deleted",content:"must not persist"})),/cannot retain/i);
    assert.throws(()=>f.spool.append(event({createdAt:null})),/publication timestamp/i);
    assert.throws(()=>f.spool.append(event({kind:"deleted",authorId})),/author identifiers/i);
    assert.doesNotThrow(()=>f.spool.append(event({createdAt:null,content:null,authorId:null})));
  }finally{f.cleanup()}
});

test("encryption key parser accepts only canonical base64 32-byte keys",()=>{
  const key=randomBytes(32);
  assert.deepEqual(parseIngressSpoolKey(key.toString("base64")),key);
  assert.throws(()=>parseIngressSpoolKey("short"),/32-byte/i);
  assert.throws(()=>parseIngressSpoolKey(Buffer.alloc(32).toString("hex")),/base64/i);
});

test("spool refuses symlink directories and unexpected files",()=>{
  const f=fixture();
  try{
    f.spool.close();
    mkdirSync(join(f.directory,"nested"));
    const link=join(f.directory,"link");
    symlinkSync(join(f.directory,"nested"),link);
    assert.throws(()=>new IngressSpool({directory:link,key:f.key}).open(),/symlink/i);
    rmSync(link);
    rmSync(join(f.directory,"nested"),{recursive:true});
    writeFileSync(join(f.directory,"unexpected.txt"),"no",{mode:0o600});
    assert.throws(()=>new IngressSpool({directory:f.directory,key:f.key}).open(),/Unexpected file/i);
  }finally{f.cleanup()}
});
