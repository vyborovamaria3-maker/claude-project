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
  assert.match(source,/const pendingDrain=drainPromise;[\s\S]*if\(pendingDrain\)await pendingDrain\.catch\(\(\)=>\{\}\);[\s\S]*if\(!stopping\)await resumeSpoolAndRecovery\(\)/);
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
  assert.match(source,/await resumeSpoolAndRecovery\(\)/);
  assert.match(source,/if\(permissionPreflightPaused\)return \{ack:false,status:"permission-preflight-paused"\}/);
});

test("shutdown waits for replay and catches spool close/fsync failures without leaking an unhandled rejection",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  assert.match(source,/await Promise\.allSettled\(\[[\s\S]*permissionPreflightPauseTask[\s\S]*drainPromise\?\?Promise\.resolve\(\)/);
  assert.match(source,/settled\.some\(result=>result\.status==="rejected"\)/);
  assert.match(source,/try\{spool\.close\(\)\}[\s\S]*ingress_spool_close_failed/);
  assert.match(source,/try\{await releaseSourceDatabase\(\)\}[\s\S]*source_database_release_failed/);
});

test("graceful shutdown keeps Gateway ingress open until destroy settles and pauses replay",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  const shutdown=source.slice(source.indexOf("async function shutdown()"));
  assert.match(shutdown,/stopping=true;[\s\S]*try\{await client\.destroy\(\)\}[\s\S]*finally\{[\s\S]*acceptingEvents=false/);
  assert.doesNotMatch(shutdown,/stopping=true;\s*acceptingEvents=false/);
  assert.match(source,/if\(client\.isReady\(\)&&!spoolReplayRetryTimer&&!stopping\)void drainSpool\(\)/);
  assert.match(source,/while\(acceptingEvents&&!stopping&&spool\.pendingCount>0\)/);
});

test("global ingress or replay failure checkpoints every active channel",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  const checkpoint=source.slice(source.indexOf("async function persistCoverageGap()"),
    source.indexOf("function ensureFatalCoverageCheckpoints()"));
  assert.match(checkpoint,/new Map\(\[\.\.\.allowed\]\./);
  assert.match(checkpoint,/recordRecoveryFailureBatch\(pool,channels,recoveryBaselines/);
  assert.match(source,/void ensureFatalCoverageCheckpoints\(\)\.finally\(\(\)=>void shutdown\(\)\)/);
});

test("fatal coverage checkpoints are single-flight and awaited before PostgreSQL closes",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  assert.match(source,/function ensureFatalCoverageCheckpoints\(\)[\s\S]*if\(!fatalCoverageScheduled\)[\s\S]*fatalCoverageTask=Promise\.resolve\(\)\.then\(async\(\)=>\{[\s\S]*await authorizationReloadTask\.catch\(\(\)=>\{\}\);[\s\S]*await persistCoverageGap\(\);/);
  assert.match(source,/startupTask,sweepTask,coverageTask,fatalCoverageTask,permissionPreflightPauseTask/);
  assert.match(source,/void ensureFatalCoverageCheckpoints\(\)\.finally\(\(\)=>void shutdown\(\)\)/);
});

test("Discord REST requests have a finite timeout before entering outage backoff",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  assert.match(source,/rest:\{timeout:15_000,retries:3\}/);
});

test("startup preflight rechecks the authorization document before retries and Gateway login",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  assert.match(source,/currentStartupDocument=await readAuthorizationFile\(authorizationPath\)/);
  assert.match(source,/verifiedStartupDocument=await readAuthorizationFile\(authorizationPath\)/);
  assert.match(source,/currentAuthorizationDocument=await readAuthorizationFile\(authorizationPath\)[\s\S]*authorizationDocumentFingerprint/);
});

test("Gateway login waits until any queued authorization reload has fully settled",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  assert.match(source,/while\(authorizationReloadRunning\)\{\s*const activeReload=authorizationReloadTask;\s*await activeReload\.catch/);
});

test("a preflight outage gap is recovered after Gateway reconnect if REST recovers first",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  assert.match(source,/recoveryPending=true/);
  assert.match(source,/backfillPendingAfterPreflightPause=true/);
  assert.match(source,/async function resumeSpoolAndRecovery\(\{reconcileGap=false\}=\{\}\)[\s\S]*await drainSpool\(\)[\s\S]*await recoverRecentGaps\(\)/);
  assert.match(source,/const resumeSpoolReplay=\(\)=>\{[\s\S]*resumeSpoolAndRecovery\(\{reconcileGap:true\}\)/);
  assert.match(source,/if\(clientReadySeen&&client\.isReady\(\)\)\s*await resumeSpoolAndRecovery\(\)/);
});

test("authorization reload treats transient preflight exceptions as a pause, not a fatal permission denial",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  assert.match(source,/catch\(error\)\{[\s\S]*isTransientDiscordRestError\(error\)[\s\S]*pauseForPermissionPreflight\(\{[\s\S]*return;/);
  assert.match(source,/if\(permissionPreflightRunning\)\{\s*try\{await permissionPreflightTask\}\s*catch\(error\)[\s\S]*discord_rest_scheduler_queue_full/);
});

test("Gateway shard resume reconciles a recent coverage gap after replay",()=>{
  const source=readFileSync(new URL("../src/index.mjs",import.meta.url),"utf8");
  assert.match(source,/resumeSpoolAndRecovery\(\{reconcileGap:true\}\)/);
  assert.match(source,/if\(reconcileGap\)recoveryPending=true/);
  assert.match(source,/if\(recoveryPending&&!stopping&&!permissionPreflightPaused/);
});
