import test from "node:test";
import assert from "node:assert/strict";
import {chmodSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeFileSync,symlinkSync} from "node:fs";
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
    assert.equal("event" in f.spool.pending.get("1"),false,"the in-memory index must not retain plaintext payloads");
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

test("sequence order remains monotonic across restart and event kinds",()=>{
  const f=fixture();
  try{
    f.spool.append(event());
    f.spool.append(event({messageId:"623456789012345678",kind:"edited",
      editedAt:"2026-11-19T12:01:00.000Z"}));
    f.spool.append(event({messageId:"723456789012345678",kind:"deleted",
      authorId:null,content:null}));
    assert.deepEqual(f.spool.listPending().map(item=>item.sequence),["1","2","3"]);
    f.spool.close();
    const reopened=new IngressSpool({directory:f.directory,key:f.key}).open();
    try{
      assert.deepEqual(reopened.listPending().map(item=>item.sequence),["1","2","3"]);
      reopened.ack("1");
      reopened.ack("2");
      reopened.ack("3");
      reopened.flushAcks();
      const next=reopened.append(event({messageId:"823456789012345678"}));
      assert.equal(next.sequence,"4");
    }finally{reopened.close()}
  }finally{f.cleanup()}
});

test("a smaller configured cap does not prevent replay of an older durable backlog",()=>{
  const f=fixture({maxBytes:100_000,maxEvents:2});
  try{
    f.spool.append(event());
    f.spool.append(event({messageId:"623456789012345678"}));
    f.spool.close();
    const reopened=new IngressSpool({directory:f.directory,key:f.key,maxBytes:100_000,maxEvents:1}).open();
    try{
      assert.equal(reopened.pendingCount,2);
      assert.throws(()=>reopened.append(event({messageId:"723456789012345678"})),
        error=>error.code==="INGRESS_SPOOL_FULL");
      reopened.ack("1");
      reopened.ack("2");
      reopened.flushAcks();
      assert.doesNotThrow(()=>reopened.append(event({messageId:"723456789012345678"})));
    }finally{reopened.close()}
  }finally{f.cleanup()}
});

test("byte capacity exhaustion leaves no partial ready event",()=>{
  const f=fixture({maxBytes:100,maxEvents:100});
  try{
    assert.throws(()=>f.spool.append(event()),error=>error.code==="INGRESS_SPOOL_FULL");
    assert.equal(f.spool.pendingCount,0);
    assert.equal(readdirSync(f.directory).length,0);
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

test("spool sweep erases queued events when an authorization lease expires",()=>{
  const f=fixture();
  try{
    f.spool.append(event());
    const allowed=new Map([[channelId,{guildId,retentionDays:30,expiresAt:"2026-11-18T00:00:00.000Z"}]]);
    const result=f.spool.sweepExpired(allowed,new Date("2026-11-19T00:00:00Z"));
    assert.equal(result.eventsErased,1);
    assert.equal(f.spool.pendingCount,0);
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
    assert.throws(()=>f.spool.append(event({createdAt:"2026-11-19+00:00",content:null,authorId:null})),/timestamp/i);
    assert.throws(()=>f.spool.append({...event(),rawGatewayPayload:{}}),/unsupported field/i);
    assert.throws(()=>f.spool.append(event({kind:"deleted",content:"must not persist"})),/cannot retain/i);
    assert.throws(()=>f.spool.append(event({createdAt:null})),/publication timestamp/i);
    assert.throws(()=>f.spool.append(event({kind:"deleted",authorId,content:null})),/author identifiers/i);
    assert.doesNotThrow(()=>f.spool.append(event({createdAt:null,content:null,authorId:null})));
  }finally{f.cleanup()}
});

test("encryption key parser accepts only canonical base64 32-byte keys",()=>{
  const key=randomBytes(32);
  assert.deepEqual(parseIngressSpoolKey(key.toString("base64")),key);
  assert.throws(()=>parseIngressSpoolKey("short"),/32-byte/i);
  assert.throws(()=>parseIngressSpoolKey(Buffer.alloc(32).toString("hex")),/base64/i);
});

test("unsafe existing permissions are rejected rather than silently widened",()=>{
  const f=fixture();
  try{
    f.spool.append(event());
    f.spool.close();
    chmodSync(f.directory,0o755);
    assert.throws(()=>new IngressSpool({directory:f.directory,key:f.key}).open(),/mode 0700/i);
    chmodSync(f.directory,0o700);
    chmodSync(join(f.directory,"00000000000000000001.evt"),0o644);
    assert.throws(()=>new IngressSpool({directory:f.directory,key:f.key}).open(),/mode 0600/i);
  }finally{f.cleanup()}
});

test("spool requires an absolute dedicated directory and rejects filesystem roots",()=>{
  const key=randomBytes(32);
  assert.throws(()=>new IngressSpool({directory:"relative/spool",key}),/absolute path/i);
  assert.throws(()=>new IngressSpool({directory:"/",key}),/filesystem root/i);
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

test("user-requested erasure removes matching encrypted spool events durably",()=>{
  const f=fixture();
  try{
    f.spool.append(event({messageId:"623456789012345678"}));
    f.spool.append(event({messageId:"723456789012345678",authorId:null}));
    f.spool.append(event({messageId:"823456789012345678",authorId:"923456789012345678"}));
    const result=f.spool.eraseAuthor(authorId,["723456789012345678"]);
    assert.equal(result.eventsErased,2);
    assert.equal(result.pendingEvents,1);
    assert.equal(f.spool.pendingCount,1);
    f.spool.close();
    const reopened=new IngressSpool({directory:f.directory,key:f.key}).open();
    try{
      const pending=reopened.listPending();
      assert.deepEqual(pending.map(item=>item.event.messageId),["823456789012345678"]);
      assert.equal(pending[0].event.authorId,"923456789012345678");
    }finally{reopened.close()}
  }finally{f.cleanup()}
});

test("user-requested spool erasure rejects non-string or malformed author identifiers",()=>{
  const f=fixture();
  try{
    assert.throws(()=>f.spool.eraseAuthor(123456789012345678),/author Snowflake/);
    assert.throws(()=>f.spool.eraseAuthor("123"),/author Snowflake/);
  }finally{f.cleanup()}
});
