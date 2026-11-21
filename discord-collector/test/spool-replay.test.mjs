import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {replaySpoolEntries,safeOldestPending} from "../src/spool-replay.mjs";

test("replay stops at a hydration barrier and leaves the blocked and later events unacknowledged",async()=>{
  const processed=[];
  const acknowledged=[];
  let flushed=0;
  const result=await replaySpoolEntries({
    entries:[{sequence:"1"},{sequence:"2"},{sequence:"3"}],
    processEntry:async entry=>{
      processed.push(entry.sequence);
      return {ack:entry.sequence==="1"};
    },
    acknowledge:sequence=>acknowledged.push(sequence),
    flushAcks:()=>{flushed++},
  });
  assert.deepEqual(processed,["1","2"]);
  assert.deepEqual(acknowledged,["1"]);
  assert.equal(flushed,1);
  assert.deepEqual(result,{acknowledged:1,blocked:true,blockedSequence:"2"});
});

test("replay flushes earlier ACKs but never ACKs the event whose processing throws",async()=>{
  const acknowledged=[];
  let flushed=0;
  await assert.rejects(replaySpoolEntries({
    entries:[{sequence:"1"},{sequence:"2"}],
    processEntry:async entry=>{
      if(entry.sequence==="2")throw new Error("database unavailable");
      return {ack:true};
    },
    acknowledge:sequence=>acknowledged.push(sequence),
    flushAcks:()=>{flushed++},
  }),/database unavailable/);
  assert.deepEqual(acknowledged,["1"]);
  assert.equal(flushed,1);
});

test("replay does not process or ACK entries after collection stops",async()=>{
  const acknowledged=[];
  let processed=0;
  const result=await replaySpoolEntries({
    entries:[{sequence:"1"}],
    processEntry:async()=>{processed++;return {ack:true}},
    acknowledge:sequence=>acknowledged.push(sequence),
    flushAcks:()=>{},
    shouldContinue:()=>false,
  });
  assert.equal(processed,0);
  assert.deepEqual(acknowledged,[]);
  assert.deepEqual(result,{acknowledged:0,blocked:false,blockedSequence:null});
});

test("replay requires an explicit ACK decision",async()=>{
  await assert.rejects(replaySpoolEntries({
    entries:[{sequence:"1"}],
    processEntry:async()=>undefined,
    acknowledge:()=>{},
    flushAcks:()=>{},
  }),/explicitly return an ACK decision/);
});

test("collector resumes spool replay on shard ready and session resume",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  assert.match(source,/client\.on\(Events\.ShardReady,resumeSpoolReplay\)/);
  assert.match(source,/client\.on\(Events\.ShardResume,resumeSpoolReplay\)/);
  assert.match(source,/if\(clientReadySeen&&client\.isReady\(\)&&!stopping\)/);
  assert.match(source,/client\.once\(Events\.ClientReady,\(\)=>\{\s*clientReadySeen=true;/);
});

test("corrupt spool diagnostics cannot interrupt fail-closed replay shutdown handling",()=>{
  const spool={get oldestPending(){throw new Error("ciphertext read failed")}};
  assert.equal(safeOldestPending(spool),null);
  assert.equal(safeOldestPending({oldestPending:{event:{channelId:"123456789012345678"}}}).event.channelId,
    "123456789012345678");
});

test("authorization reload waits for an in-flight replay and retries the spool under the new lease",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  assert.match(source,/const pendingDrain=drainPromise;[\s\S]*if\(pendingDrain\)await pendingDrain\.catch\(\(\)=>\{\}\);[\s\S]*if\(!stopping\)await drainSpool\(\)/);
});

test("collector retains a transiently blocked spool head and retries with capped backoff",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  assert.match(source,/isTransientDiscordRestError\(error\)/);
  assert.match(source,/retryable\.code="DISCORD_REST_TRANSIENT"/);
  assert.match(source,/scheduleSpoolReplayRetry\(error\)/);
  assert.match(source,/retryDelayMs\(spoolReplayRetryAttempt\+\+,[\s\S]*maxMs:300_000/);
  assert.match(source,/encrypted ingress backlog retained/);
  assert.match(source,/clearTimeout\(spoolReplayRetryTimer\)/);
});

test("startup preflight retries transient API outages before Gateway login and records a coverage watermark",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  assert.match(source,/while\(true\)\{[\s\S]*runPermissionPreflight\(allowed\)[\s\S]*isTransientPermissionPreflightReport\(initialPermissionReport\)[\s\S]*recordRecoveryCheck\(pool,permission\.guildId,channelId[\s\S]*retryDelayMs\(initialPreflightRetryAttempt\+\+/);
  assert.match(source,/startup remains paused and will retry/);
});

test("periodic preflight outage pauses capture, persists a gap, retries, and resumes bounded recovery",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  assert.match(source,/permissionPreflightPaused=true;[\s\S]*acceptingEvents=false/);
  assert.match(source,/permission_preflight_gap_checkpoint_failed/);
  assert.match(source,/schedulePermissionPreflightRetry\(report\)/);
  assert.match(source,/startPermissionPreflight\(\{retry:true\}\)/);
  assert.match(source,/permissionPreflightPaused=false;[\s\S]*acceptingEvents=true/);
  assert.match(source,/await drainSpool\(\);[\s\S]*await recoverRecentGaps\(\)/);
  assert.match(source,/if\(permissionPreflightPaused\)return \{ack:false,status:"permission-preflight-paused"\}/);
});

test("shutdown waits for replay and catches spool close/fsync failures without leaking an unhandled rejection",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  assert.match(source,/await Promise\.allSettled\(\[[\s\S]*permissionPreflightPauseTask[\s\S]*drainPromise\?\?Promise\.resolve\(\)/);
  assert.match(source,/try\{spool\.close\(\)\}[\s\S]*ingress_spool_close_failed/);
  assert.match(source,/try\{await releaseSourceDatabase\(\)\}[\s\S]*source_database_release_failed/);
});
