import {readAuthorizationFile} from "./authorization-file.mjs";
import {Client,GatewayIntentBits,Events,Partials} from "discord.js";
import pg from "pg";
import {validateAuthorization,normalizeMessage,allowedObservation,isMetadataOnlyMessageUpdate,isEventCurrentlyAuthorized} from "./events.mjs";
import {installSchema,storeObservation,getBackfillCursor,advanceBackfillCursor,purgeExpired,getRecoveryBaseline,recordRecoveryCheck,recordCoverageFailure} from "./storage.mjs";
import {scanRecentGap} from "./reconcile.mjs";
import {IngressSpool,parseIngressSpoolKey} from "./ingress-spool.mjs";
import {createDiscordPermissionPreflightRunner} from "./permission-preflight.mjs";
import {replaySpoolEntries,safeOldestPending} from "./spool-replay.mjs";
import {RestScheduler} from "./rest-scheduler.mjs";
import {isTransientDiscordRestError,isTransientPermissionPreflightReport,permissionPreflightRetryBaseMs,retryDelayMs} from "./retry-policy.mjs";

if(process.env.DISCORD_COLLECTOR_ENABLED!=="true"){
  console.error("Disabled: DISCORD_COLLECTOR_ENABLED is not true");
  process.exit(0);
}
for(const key of ["DISCORD_SOURCE_DATABASE_URL","DISCORD_AUTHORIZATION_PATH",
  "DISCORD_INGRESS_SPOOL_DIR","DISCORD_INGRESS_SPOOL_KEY"]){
  if(!process.env[key])throw new Error("Missing config: "+key);
}
const botToken=process.env.DISCORD_BOT_TOKEN??null;
const sourceDatabaseUrl=process.env.DISCORD_SOURCE_DATABASE_URL;
const authorizationPath=process.env.DISCORD_AUTHORIZATION_PATH;
const spoolDirectory=process.env.DISCORD_INGRESS_SPOOL_DIR;
const allowErasureOnly=process.env.DISCORD_ALLOW_ERASURE_ONLY==="true";
const doc=await readAuthorizationFile(authorizationPath);
let allowed=validateAuthorization(doc,{allowErasureOnly});
let erasureOnly=allowed.erasureOnly||(allowed.size===0&&allowed.expiredChannels.length>0);
if(allowed.size>0&&!botToken)throw new Error("DISCORD_BOT_TOKEN is required while authorized channels are active");
const spoolKey=parseIngressSpoolKey(process.env.DISCORD_INGRESS_SPOOL_KEY);
for(const secretName of ["DISCORD_BOT_TOKEN","DISCORD_SOURCE_DATABASE_URL",
  "DISCORD_AUTHORIZATION_PATH","DISCORD_INGRESS_SPOOL_KEY"])
  delete process.env[secretName];
const spoolMaxBytes=Number(process.env.DISCORD_INGRESS_SPOOL_MAX_BYTES||536_870_912);
const spoolMaxEvents=Number(process.env.DISCORD_INGRESS_SPOOL_MAX_EVENTS||100_000);
if(!Number.isSafeInteger(spoolMaxBytes)||spoolMaxBytes<1_048_576||spoolMaxBytes>10_737_418_240)
  throw new RangeError("DISCORD_INGRESS_SPOOL_MAX_BYTES must be in 1 MiB..10 GiB");
if(!Number.isSafeInteger(spoolMaxEvents)||spoolMaxEvents<1||spoolMaxEvents>1_000_000)
  throw new RangeError("DISCORD_INGRESS_SPOOL_MAX_EVENTS must be in 1..1000000");
const recoveryMaxPages=Number(process.env.DISCORD_GAP_RECOVERY_MAX_PAGES||5);
if(process.env.DISCORD_GAP_RECOVERY_ENABLED==="true" &&
   (!Number.isInteger(recoveryMaxPages)||recoveryMaxPages<1||recoveryMaxPages>50))
  throw new RangeError("DISCORD_GAP_RECOVERY_MAX_PAGES must be in 1..50");
const authorizationReloadMs=Number(process.env.DISCORD_AUTHORIZATION_RELOAD_MS||30_000);
if(!Number.isInteger(authorizationReloadMs)||authorizationReloadMs<5_000||authorizationReloadMs>60_000)
  throw new RangeError("DISCORD_AUTHORIZATION_RELOAD_MS must be in 5000..60000");
const permissionPreflightMaxChannels=Number(process.env.DISCORD_PERMISSION_PREFLIGHT_MAX_CHANNELS||1_000);
if(!Number.isInteger(permissionPreflightMaxChannels)||permissionPreflightMaxChannels<1||permissionPreflightMaxChannels>10_000)
  throw new RangeError("DISCORD_PERMISSION_PREFLIGHT_MAX_CHANNELS must be in 1..10000");
const permissionPreflightIntervalMs=Number(process.env.DISCORD_PERMISSION_PREFLIGHT_INTERVAL_MS||300_000);
if(!Number.isInteger(permissionPreflightIntervalMs)||permissionPreflightIntervalMs<60_000||permissionPreflightIntervalMs>900_000)
  throw new RangeError("DISCORD_PERMISSION_PREFLIGHT_INTERVAL_MS must be in 60000..900000");
const permissionPreflightMinRequestIntervalMs=Number(process.env.DISCORD_PERMISSION_PREFLIGHT_MIN_REQUEST_INTERVAL_MS||25);
if(!Number.isInteger(permissionPreflightMinRequestIntervalMs)||permissionPreflightMinRequestIntervalMs<0||permissionPreflightMinRequestIntervalMs>1_000)
  throw new RangeError("DISCORD_PERMISSION_PREFLIGHT_MIN_REQUEST_INTERVAL_MS must be in 0..1000");
const estimatedPreflightRequests=3*permissionPreflightMaxChannels+1;
if(permissionPreflightIntervalMs<estimatedPreflightRequests*permissionPreflightMinRequestIntervalMs)
  throw new RangeError("Permission preflight interval is too short for the configured channel cap and REST pacing");
if(allowed.size>0&&process.env.DISCORD_PERMISSION_PREFLIGHT_ENABLED!=="true")
  throw new Error("DISCORD_PERMISSION_PREFLIGHT_ENABLED=true is mandatory before Gateway login");
if(allowed.size>0&&process.env.DISCORD_MESSAGE_CONTENT_INTENT_CONFIRMED!=="true")
  throw new Error("Confirm the approved Message Content intent with DISCORD_MESSAGE_CONTENT_INTENT_CONFIRMED=true");

const pool=new pg.Pool({connectionString:sourceDatabaseUrl,max:4,connectionTimeoutMillis:10_000,keepAlive:true,application_name:"potapoff-discord-collector"});
const singletonClient=await pool.connect().catch(async error=>{spoolKey.fill(0);await pool.end();throw error});
let singletonLockHeld=false;
let spool=null;
const recoveryBaselines=new Map();
const restScheduler=new RestScheduler({maxPending:100});
async function scheduleRest(task,options){
  try{return await restScheduler.run(task,options)}
  catch(error){
    if((error?.status===429||error?.code===429)&&error?.code!=="discord_rate_limited")restRateLimitResponses++;
    throw error;
  }
}
let restRateLimitResponses=0;
const runPermissionPreflight=createDiscordPermissionPreflightRunner({
  token:botToken,
  maxChannels:permissionPreflightMaxChannels,
  minRequestIntervalMs:permissionPreflightMinRequestIntervalMs,
  onRateLimit:()=>{restRateLimitResponses++},
});
let startupSpoolSweep={eventsErased:0};
let startupPurge={rowsErased:0,tombstonesQueued:0};
let clientReadySeen=false;
async function releaseSourceDatabase(){
  try{
    if(singletonLockHeld)
      await singletonClient.query("SELECT pg_advisory_unlock(hashtextextended('potapoff:discord-collector:singleton',0))");
    singletonLockHeld=false;
    singletonClient.release();
  }catch(error){
    singletonLockHeld=false;
    singletonClient.release(error);
  }
  await pool.end();
}
try{
  // One Collector per source database. A session advisory lock is released by
  // PostgreSQL automatically if the process or connection dies.
  const lock=await singletonClient.query(
    "SELECT pg_try_advisory_lock(hashtextextended('potapoff:discord-collector:singleton',0)) AS acquired");
  if(lock.rows[0]?.acquired!==true)throw new Error("Another Discord Collector already holds the source lock");
  singletonLockHeld=true;
  spool=new IngressSpool({
    directory:spoolDirectory,
    key:spoolKey,
    maxBytes:spoolMaxBytes,
    maxEvents:spoolMaxEvents,
  }).open();
  spoolKey.fill(0);
  // Remove revoked or expired pending payloads before any Gateway connection.
  startupSpoolSweep=spool.sweepExpired(allowed);
  // Schema and erasure tombstones must be ready before Gateway login.
  await installSchema(pool);
  startupPurge=await purgeExpired(pool,allowed,{allowEmpty:erasureOnly});
  for(const channelId of allowed.keys())
    recoveryBaselines.set(channelId,await getRecoveryBaseline(pool,channelId));
}catch(error){
  spoolKey.fill(0);
  try{spool?.close()}catch{}
  await releaseSourceDatabase();
  throw error;
}

if(startupSpoolSweep.eventsErased>0||startupPurge.rowsErased>0)
  console.log("Startup Discord erasure sweep",{
    pendingIngressEvents:startupSpoolSweep.eventsErased,
    sourceRows:startupPurge.rowsErased,
    tombstonesQueued:startupPurge.tombstonesQueued,
    expiredChannels:allowed.expiredChannels.length,
  });
if(erasureOnly){
  console.log("Discord authorization has no active channels; completed erasure-only run",{
    expiredChannels:allowed.expiredChannels.length,
    sourceRows:startupPurge.rowsErased,
    tombstonesQueued:startupPurge.tombstonesQueued,
  });
  try{spool.close()}finally{await releaseSourceDatabase()}
  process.exit(0);
}

let initialPermissionReport;
let initialPermissionError=null;
let initialPreflightRetryAttempt=0;
let initialPreflightGapRecorded=false;
while(true){
  try{
    const currentStartupDocument=await readAuthorizationFile(authorizationPath);
    if(JSON.stringify(currentStartupDocument)!==JSON.stringify(doc)){
      initialPermissionError=Object.assign(new Error("authorization_changed_during_startup_preflight"),{
        code:"authorization_changed_during_startup_preflight",
      });
      break;
    }
    initialPermissionReport=await runPermissionPreflight(allowed);
  }catch(error){
    if(!isTransientDiscordRestError(error)){
      initialPermissionError=error;
      break;
    }
    initialPermissionError=error;
  }
  if(initialPermissionReport?.ok){
    try{
      const verifiedStartupDocument=await readAuthorizationFile(authorizationPath);
      if(JSON.stringify(verifiedStartupDocument)!==JSON.stringify(doc)){
        initialPermissionError=Object.assign(new Error("authorization_changed_during_startup_preflight"),{
          code:"authorization_changed_during_startup_preflight",
        });
        initialPermissionReport=null;
        break;
      }
    }catch(error){
      initialPermissionError=error;
      initialPermissionReport=null;
      break;
    }
    break;
  }
  if(initialPermissionReport&&!isTransientPermissionPreflightReport(initialPermissionReport))break;
  const transientCode=initialPermissionReport?.errorCode??initialPermissionError?.code??"discord_api_unavailable";
  if(!initialPreflightGapRecorded){
    for(const [channelId,permission] of allowed)
      await recordRecoveryCheck(pool,permission.guildId,channelId,
        recoveryBaselines.get(channelId)??null,{status:"failed"});
    initialPreflightGapRecorded=true;
  }
  const delay=retryDelayMs(initialPreflightRetryAttempt++,{
    baseMs:permissionPreflightRetryBaseMs(initialPermissionReport,initialPermissionError),
    maxMs:300_000,
  });
  console.warn("Discord permission preflight unavailable; startup remains paused and will retry",{
    errorCode:transientCode,retryInMs:delay,
  });
  await new Promise(resolve=>setTimeout(resolve,delay));
  initialPermissionReport=null;
  initialPermissionError=null;
}
if(!initialPermissionReport?.ok){
  const failureCodes=[...new Set((initialPermissionReport?.guilds??[])
    .flatMap(group=>group.channels.map(channel=>channel.errorCode).filter(Boolean)))];
  console.error("Discord permission preflight failed; Gateway login was not attempted",{
    status:initialPermissionReport?.status??"error",
    checkedChannels:initialPermissionReport?.checkedChannels??allowed.size,
    failedChannels:initialPermissionReport?.failedChannels??allowed.size,
    errorCodes:failureCodes,
    errorCode:initialPermissionReport?.errorCode??initialPermissionError?.code??"permission_preflight_failed",
  });
  try{spool.close()}finally{await releaseSourceDatabase()}
  throw new Error("Discord permission preflight failed; collection remains stopped");
}
console.log("Discord permission preflight passed",{
  checkedGuilds:initialPermissionReport.checkedGuilds,
  checkedChannels:initialPermissionReport.checkedChannels,
  rateLimitResponses:restRateLimitResponses,
});
const client=new Client({
  intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],
  partials:[Partials.Message,Partials.Channel],
  // Bound hung REST requests so a prolonged API outage reaches the durable
  // spool retry/backoff path instead of pinning replay and shutdown forever.
  rest:{timeout:15_000,retries:3},
});
let failures=0;
let acceptingEvents=true;
let stopping=false;
let shutdownPromise=null;
let startupTask=Promise.resolve();
let sweepTask=Promise.resolve();
let coverageTask=Promise.resolve();
let fatalCoverageTask=Promise.resolve();
let fatalCoverageScheduled=false;
let drainPromise=null;
let spoolReplayRetryTimer=null;
let spoolReplayRetryAttempt=0;
let sweepTimer;
let backlogTimer;
let authorizationReloadTimer;
let authorizationExpiryTimer;
let authorizationReloadTask=Promise.resolve();
let permissionPreflightTimer;
let permissionPreflightTask=Promise.resolve();
let permissionPreflightRunning=false;
let permissionPreflightFailed=false;
let permissionPreflightPaused=false;
let recoveryPending=false;
let backfillPendingAfterPreflightPause=false;
let permissionPreflightRetryTimer=null;
let permissionPreflightRetryAttempt=0;
let permissionPreflightPauseTask=Promise.resolve();
let sweepRunning=false;

function singletonConnectionLost(){
  if(stopping)return;
  acceptingEvents=false;
  failures++;
  process.exitCode=1;
  console.error("Discord singleton lock connection lost","singleton_lock_lost");
  void shutdown();
}
singletonClient.on("error",singletonConnectionLost);
singletonClient.on("end",singletonConnectionLost);
try{await singletonClient.query("SELECT 1")}
catch{
  await shutdown();
  throw new Error("Discord singleton lock connection is not healthy");
}

function permissionActive(permission){
  if(!permission)return false;
  if(permission.expiresAt===undefined||permission.expiresAt===null)return true; // Legacy in-memory fixtures only.
  const expiry=Date.parse(permission.expiresAt);
  return Number.isFinite(expiry)&&expiry>Date.now();
}

function sameAuthorizationLease(current,expected){
  return Boolean(current&&expected&&
    current.guildId===expected.guildId&&
    current.retentionDays===expected.retentionDays&&
    current.permissionReference===expected.permissionReference&&
    current.policyReviewReference===expected.policyReviewReference&&
    current.permissionExpiresAt===expected.permissionExpiresAt&&
    current.policyReviewExpiresAt===expected.policyReviewExpiresAt&&
    current.expiresAt===expected.expiresAt);
}

function permissionPreflightSummary(report){
  return {
    status:report.status,
    checkedGuilds:report.checkedGuilds,
    checkedChannels:report.checkedChannels,
    passedChannels:report.passedChannels,
    failedChannels:report.failedChannels,
    errorCodes:[...new Set(report.guilds.flatMap(group=>
      group.channels.map(channel=>channel.errorCode).filter(Boolean)))],
    errorCode:report.errorCode,
  };
}

async function verifyPermissions(snapshot){
  if(permissionPreflightFailed)throw new Error("Discord permission verification already failed");
  if(permissionPreflightRunning){
    try{await permissionPreflightTask}
    catch(error){
      if(permissionPreflightFailed||
         (!isTransientDiscordRestError(error)&&error?.code!=="discord_rest_scheduler_queue_full"))
        throw error;
    }
  }
  if(permissionPreflightFailed)throw new Error("Discord permission verification already failed");
  permissionPreflightRunning=true;
  const task=scheduleRest(()=>runPermissionPreflight(snapshot),{priority:0,label:"permission-preflight"});
  permissionPreflightTask=task;
  try{
    const report=await task;
    if(!report.ok&&!isTransientPermissionPreflightReport(report))permissionPreflightFailed=true;
    return report;
  }catch(error){
    if(!isTransientDiscordRestError(error)&&error?.code!=="discord_rest_scheduler_queue_full")
      permissionPreflightFailed=true;
    throw error;
  }finally{
    if(permissionPreflightTask===task)permissionPreflightRunning=false;
  }
}

async function record(message,kind,authorizationRetry=0){
  if(permissionPreflightPaused)throw new Error("discord_permission_preflight_paused");
  const channelId=String(message.channelId??message.channel?.id??"");
  const permission=allowed.get(channelId);
  if(!permissionActive(permission))return {status:"not-allowed"};
  const observation=normalizeMessage(message,kind,new Date().toISOString(),permission.guildId);
  if(!allowedObservation(allowed,observation))return {status:"not-allowed"};
  const stillAuthorized=()=>{
    const current=allowed.get(channelId);
    return !permissionPreflightPaused&&permissionActive(current)&&sameAuthorizationLease(current,permission);
  };
  const result=await storeObservation(pool,observation,permission.retentionDays,
    new Date(),permission.expiresAt,stillAuthorized);
  if(["not-authorized","authorization-expired"].includes(result.status)&&
     isEventCurrentlyAuthorized(allowed,observation)){
    if(authorizationRetry>=2)
      throw new Error("authorization_changed_during_source_write");
    // A renewed lease still authorizes this channel. Re-evaluate retention and
    // retry instead of letting backfill advance its cursor past a lost event.
    return record(message,kind,authorizationRetry+1);
  }
  return result;
}

async function persistCoverageGap(){
  // A fatal ingress/replay failure stops the whole Collector, not just the
  // channel whose event happened to expose the failure. Preserve a checkpoint
  // for every still-authorized channel so disabled/bounded recovery cannot
  // silently move the other channels' watermarks past the outage.
  let checkpointFailures=0;
  for(const [channelId,permission] of allowed){
    if(!permissionActive(permission))continue;
    const stillAuthorized=()=>{
      const current=allowed.get(channelId);
      return permissionActive(current)&&sameAuthorizationLease(current,permission);
    };
    try{
      await recordRecoveryCheck(pool,permission.guildId,channelId,
        recoveryBaselines.get(channelId)??null,{status:"failed"},stillAuthorized);
    }catch{
      checkpointFailures++;
    }
  }
  if(checkpointFailures>0)
    throw new Error("discord_recovery_gap_checkpoint_failed");
}

function ensureFatalCoverageCheckpoints(){
  // Ingress append failure and an in-flight replay failure can race. Share one
  // checkpoint task so shutdown cannot close PostgreSQL while a second set of
  // recovery writes is still running, and do not overwrite the preflight task.
  if(!fatalCoverageScheduled){
    fatalCoverageScheduled=true;
    fatalCoverageTask=Promise.resolve().then(()=>persistCoverageGap()).catch(()=>{
      console.error("Discord fatal coverage checkpoints could not all be persisted");
    });
  }
  return fatalCoverageTask;
}

function isoOrNull(value,fallbackTimestamp){
  if(value instanceof Date&&Number.isFinite(value.getTime()))return value.toISOString();
  if(Number.isFinite(fallbackTimestamp))return new Date(fallbackTimestamp).toISOString();
  return null;
}

function snapshotGatewayEvent(kind,message,permission){
  const channelId=String(message.channelId??message.channel?.id??"");
  const createdAt=isoOrNull(message.createdAt,message.createdTimestamp);
  const retainPersonalFields=kind!=="deleted"&&createdAt!==null;
  const authorId=retainPersonalFields&&message.author?.id?String(message.author.id):null;
  return {
    kind,
    messageId:String(message.id??""),
    guildId:String(message.guildId??message.guild?.id??permission.guildId),
    channelId,
    // Content is retained only when its author can be tied to the source row.
    // Authorless partial events remain identifier-only until REST hydration.
    authorId,
    content:authorId!==null&&typeof message.content==="string"?message.content:null,
    createdAt,
    editedAt:isoOrNull(message.editedAt,message.editedTimestamp),
    receivedAt:new Date().toISOString(),
  };
}

function failCollector(code){
  if(!acceptingEvents)return;
  acceptingEvents=false;
  failures++;
  process.exitCode=1;
  console.error("Discord durable ingress stopped",code);
  void ensureFatalCoverageCheckpoints().finally(()=>void shutdown());
}

function enqueueGatewayEvent(kind,message){
  if(!acceptingEvents)return;
  const channelId=String(message.channelId??message.channel?.id??"");
  const permission=allowed.get(channelId);
  if(!permissionActive(permission))return;
  try{
    const event=snapshotGatewayEvent(kind,message,permission);
    // append() writes an encrypted record, fsyncs the file, atomically renames
    // it, and fsyncs the directory before this Gateway callback returns.
    spool.append(event);
  }catch(error){
    failCollector(error?.code==="INGRESS_SPOOL_FULL"?"ingress_spool_full":"ingress_spool_write_failed");
    return;
  }
  if(client.isReady()&&!spoolReplayRetryTimer&&!stopping)void drainSpool().catch(()=>{});
}

function scheduleSpoolReplayRetry(error){
  if(stopping||permissionPreflightPaused||spoolReplayRetryTimer)return null;
  const baseMs=Number(error?.status??error?.statusCode)===429?30_000:1_000;
  const delay=retryDelayMs(spoolReplayRetryAttempt++,{baseMs,maxMs:300_000});
  spoolReplayRetryTimer=setTimeout(()=>{
    spoolReplayRetryTimer=null;
    if(clientReadySeen&&client.isReady()&&!stopping&&!spoolReplayRetryTimer)
      void resumeSpoolAndRecovery().catch(()=>{});
  },delay);
  spoolReplayRetryTimer.unref();
  return delay;
}

function isUnknownDiscordMessage(error){
  // Only Discord's explicit Unknown Message code is terminal. A generic HTTP
  // 404 may describe a missing channel/route and must not silently ACK data.
  return error?.code===10008||error?.rawError?.code===10008;
}

async function processSpoolEntry(entry,{allowHydration=true}={}){
  if(permissionPreflightPaused)return {ack:false,status:"permission-preflight-paused"};
  const event=entry.event;
  const permission=allowed.get(event.channelId);
  if(!permissionActive(permission)||permission.guildId!==event.guildId)
    return {ack:true,status:"not-authorized"}; // Current allowlist wins over queued data.

  let message={
    id:event.messageId,
    guildId:event.guildId,
    channelId:event.channelId,
    author:event.authorId?{id:event.authorId}:null,
    content:event.content,
    createdAt:event.createdAt?new Date(event.createdAt):null,
    editedAt:event.editedAt?new Date(event.editedAt):null,
  };
  const needsHydration=event.kind!=="deleted"&&
    (!event.createdAt||!event.authorId||event.content===null||(event.kind==="edited"&&!event.editedAt));
  if(needsHydration&&!allowHydration){
    // Keep this exact encrypted record at the head of the queue. The Gateway
    // must be allowed to connect before REST hydration can be attempted.
    return {ack:false,status:"needs_hydration"};
  }
  if(needsHydration){
    try{
      const channel=await scheduleRest(()=>client.channels.fetch(event.channelId),
        {priority:0,label:"message-hydration-channel"});
      if(!channel?.messages)throw new Error("Authorized Discord channel history is unavailable");
      message=await scheduleRest(()=>channel.messages.fetch(event.messageId),
        {priority:0,label:"message-hydration"});
    }catch(error){
      if(!isUnknownDiscordMessage(error)){
        if(isTransientDiscordRestError(error)){
          const retryable=new Error("discord_rest_temporarily_unavailable");
          retryable.code="DISCORD_REST_TRANSIENT";
          retryable.status=error?.status??error?.statusCode??null;
          throw retryable;
        }
        throw error;
      }
      const currentPermission=allowed.get(event.channelId);
      if(!permissionActive(currentPermission)||currentPermission.guildId!==event.guildId)
        return {ack:true,status:"not-authorized"};
      // A terminal Unknown Message is not hydratable. Persist a per-message,
      // content-free coverage failure before ACK so analytics can see the gap.
      const stillAuthorized=()=>{
        const current=allowed.get(event.channelId);
        return !permissionPreflightPaused&&permissionActive(current)&&sameAuthorizationLease(current,currentPermission);
      };
      const recorded=await recordCoverageFailure(
        pool,event,currentPermission.retentionDays,stillAuthorized,
      );
      if(!recorded)return isEventCurrentlyAuthorized(allowed,event)
        ? {ack:false,status:"authorization-changed"}
        : {ack:true,status:"not-authorized"};
      const recoveryRecorded=await recordRecoveryCheck(pool,currentPermission.guildId,event.channelId,
        recoveryBaselines.get(event.channelId)??null,{status:"failed"},stillAuthorized);
      if(!recoveryRecorded&&isEventCurrentlyAuthorized(allowed,event))
        return {ack:false,status:"authorization-changed"};
      failures++;
      process.exitCode=1;
      console.error("Discord ingress event could not be hydrated; durable coverage gap recorded",event.kind);
      return {ack:true,status:"coverage-gap"};
    }
  }
  // Discord MESSAGE_UPDATE also fires for metadata-only changes such as pins
  // and flags. If neither the Gateway event nor the hydrated message has a
  // source edit timestamp, it is not a content revision and must not stop replay.
  if(isMetadataOnlyMessageUpdate(event,message))
    return {ack:true,status:"non-content-update"};
  const observation=normalizeMessage(message,event.kind,event.receivedAt,event.guildId);
  if(!allowedObservation(allowed,observation))return {ack:true,status:"not-allowed"};
  const currentPermission=allowed.get(event.channelId);
  if(!permissionActive(currentPermission)||currentPermission.guildId!==event.guildId)
    return {ack:true,status:"not-authorized"};
  const stillAuthorized=()=>{
    const current=allowed.get(event.channelId);
    return !permissionPreflightPaused&&permissionActive(current)&&sameAuthorizationLease(current,currentPermission);
  };
  const result=await storeObservation(pool,observation,currentPermission.retentionDays,
    new Date(),currentPermission.expiresAt,stillAuthorized);
  if(["not-authorized","authorization-expired"].includes(result.status)&&
     isEventCurrentlyAuthorized(allowed,event))
    return {ack:false,status:"authorization-changed"};
  return {ack:true,status:result.status};
}

function drainSpool({allowHydration=true}={}){
  if(stopping||permissionPreflightPaused||spoolReplayRetryTimer)return Promise.resolve();
  if(drainPromise)return drainPromise;
  drainPromise=(async()=>{
    while(acceptingEvents&&!stopping&&spool.pendingCount>0){
      const batch=spool.listPending(100);
      const replay=await replaySpoolEntries({
        entries:batch,
        processEntry:entry=>processSpoolEntry(entry,{allowHydration}),
        acknowledge:sequence=>spool.ack(sequence),
        flushAcks:()=>spool.flushAcks(),
        shouldContinue:()=>acceptingEvents&&!stopping,
      });
      if(replay.blocked){
        console.log("Discord durable ingress replay deferred until Gateway REST hydration",{
          pendingEvents:spool.pendingCount,
          blockedSequence:replay.blockedSequence,
        });
        break;
      }
      if(spool.pendingCount>0)await new Promise(resolve=>setImmediate(resolve));
    }
    if(spool.pendingCount===0)spoolReplayRetryAttempt=0;
  })().catch(error=>{
    if(error?.code==="DISCORD_REST_TRANSIENT"){
      const retryInMs=scheduleSpoolReplayRetry(error);
      console.warn("Discord REST temporarily unavailable; encrypted ingress backlog retained",{
        pendingEvents:spool.pendingCount,
        pendingBytes:spool.pendingBytes,
        retryInMs,
      });
      return;
    }
    failures++;
    acceptingEvents=false;
    const oldest=safeOldestPending(spool);
    process.exitCode=1;
    console.error("Discord durable ingress replay stopped; event retained for restart",
      error?.code??"ingress_replay_failed",oldest?{blockedSequence:oldest.sequence}:null);
    void ensureFatalCoverageCheckpoints().finally(()=>void shutdown());
    throw error;
  }).finally(()=>{drainPromise=null;});
  return drainPromise;
}

client.on(Events.MessageCreate,message=>enqueueGatewayEvent("observed",message));
client.on(Events.MessageUpdate,(_before,after)=>enqueueGatewayEvent("edited",after));
client.on(Events.MessageDelete,message=>enqueueGatewayEvent("deleted",message));
client.on(Events.MessageBulkDelete,messages=>{
  for(const message of messages.values())enqueueGatewayEvent("deleted",message);
});

// ClientReady fires only once. Resume durable backlog after reconnect even
// when no new message arrives to trigger enqueueGatewayEvent.
const resumeSpoolReplay=()=>{
  if(clientReadySeen&&client.isReady()&&!stopping)
    void resumeSpoolAndRecovery({reconcileGap:true}).catch(()=>{});
};
client.on(Events.ShardReady,resumeSpoolReplay);
client.on(Events.ShardResume,resumeSpoolReplay);

async function backfill(guildId,channelId,maxMessages){
  const permission=allowed.get(channelId);
  if(permissionPreflightPaused||!permissionActive(permission)||permission.guildId!==guildId)return;
  const stillAuthorized=()=>{
    const current=allowed.get(channelId);
    return !permissionPreflightPaused&&permissionActive(current)&&sameAuthorizationLease(current,permission);
  };
  const channel=await scheduleRest(()=>client.channels.fetch(channelId),
    {priority:2,label:"history-backfill-channel"});
  if(!channel?.messages)throw new Error("Channel not accessible for history");
  let cursor=await getBackfillCursor(pool,channelId);
  let count=0;
  while(count<maxMessages&&!stopping&&!permissionPreflightPaused&&stillAuthorized()){
    const requested=Math.min(100,maxMessages-count);
    const page=await scheduleRest(
      ()=>channel.messages.fetch({limit:requested,...(cursor?{before:cursor}:{})}),
      {priority:2,label:"history-backfill-page"},
    );
    if(page.size===0)break;
    const ordered=[...page.values()].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
    for(const message of ordered){
      if(stopping||permissionPreflightPaused)break;
      await record(message,"observed");
      count++;
    }
    if(stopping||permissionPreflightPaused||!stillAuthorized())break;
    cursor=ordered[0].id;
    // Cursor never advances past a failed page; successful rows replay idempotently.
    if(!await advanceBackfillCursor(pool,guildId,channelId,cursor,stillAuthorized))break;
    if(page.size<requested)break;
  }
  console.log("History sync pass",{channelId,processed:count});
}

async function recoverRecentGaps(){
  if(process.env.DISCORD_GAP_RECOVERY_ENABLED!=="true")return;
  for(const [channelId,permission] of allowed){
    if(stopping||permissionPreflightPaused)break;
    const baseline=await getRecoveryBaseline(pool,channelId);
    recoveryBaselines.set(channelId,baseline);
    try{
      const stillAuthorized=()=>{
        const current=allowed.get(channelId);
        return !permissionPreflightPaused&&permissionActive(current)&&sameAuthorizationLease(current,permission);
      };
      const channel=await scheduleRest(()=>client.channels.fetch(channelId),
        {priority:1,label:"gap-recovery-channel"});
      if(!stillAuthorized())continue;
      const result=await scanRecentGap({
        channel,
        fetchPage:options=>scheduleRest(()=>channel.messages.fetch(options),
          {priority:1,label:"gap-recovery-page"}),
        baselineMessageId:baseline,
        maxPages:recoveryMaxPages,
        shouldContinue:stillAuthorized,
        onMessage:message=>record(message,"observed"),
      });
      if(!await recordRecoveryCheck(pool,permission.guildId,channelId,baseline,result,stillAuthorized))
        continue;
      console.log("Discord recovery window",{channelId,status:result.status,
        pages:result.pagesScanned,processed:result.messagesProcessed});
    }catch(error){
      if(permissionPreflightPaused)break;
      failures++;
      try{
        const stillAuthorized=()=>{
          const current=allowed.get(channelId);
          return !permissionPreflightPaused&&permissionActive(current)&&sameAuthorizationLease(current,permission);
        };
        await recordRecoveryCheck(pool,permission.guildId,channelId,baseline,{status:"failed"},stillAuthorized);
      }catch{
        if(permissionPreflightPaused)break;
        console.error("Recovery failure status could not be saved",channelId);
        process.exitCode=1;
        void shutdown();
      }
      console.error("Discord gap recovery failed",channelId,error?.code??"recovery_failed");
    }
  }
}

async function runConfiguredBackfill(){
  const max=Number(process.env.DISCORD_BACKFILL_MAX_MESSAGES||0);
  if(process.env.DISCORD_BACKFILL_ENABLED!=="true"||!Number.isInteger(max)||max<=0)return;
  for(const [channelId,permission] of allowed){
    if(stopping||permissionPreflightPaused)break;
    try{await backfill(permission.guildId,channelId,max)}
    catch(error){
      if(permissionPreflightPaused)break;
      failures++;
      console.error("History backfill failed",channelId,error?.code??"backfill_failed");
    }
  }
}

async function resumeSpoolAndRecovery({reconcileGap=false}={}){
  if(reconcileGap)recoveryPending=true;
  if(stopping||permissionPreflightPaused||!clientReadySeen||!client.isReady())return;
  await drainSpool();
  if(recoveryPending&&!stopping&&!permissionPreflightPaused&&
     !spoolReplayRetryTimer&&spool.pendingCount===0){
    await recoverRecentGaps();
    if(backfillPendingAfterPreflightPause){
      if(!stopping&&!permissionPreflightPaused)await runConfiguredBackfill();
      backfillPendingAfterPreflightPause=false;
    }
    recoveryPending=false;
  }
}

let authorizationReloadRunning=false;
let authorizationReloadPending=false;
let authorizationDocumentFingerprint=JSON.stringify(doc);
function authorizationStateFingerprint(snapshot){
  return JSON.stringify({
    mode:snapshot.mode,
    channels:[...snapshot.entries()].map(([channelId,permission])=>[
      channelId,permission.guildId,permission.retentionDays,
      permission.permissionReference,permission.policyReviewReference,
      permission.permissionExpiresAt,permission.policyReviewExpiresAt,
    ]),
    expired:[...snapshot.expiredChannels].sort(),
  });
}
let authorizationState=authorizationStateFingerprint(allowed);

async function reloadAuthorization(){
  const nextDocument=await readAuthorizationFile(authorizationPath);
  const next=validateAuthorization(nextDocument,{allowErasureOnly});
  const nextErasureOnly=next.erasureOnly||(next.size===0&&next.expiredChannels.length>0);
  const nextDocumentFingerprint=JSON.stringify(nextDocument);
  const nextState=authorizationStateFingerprint(next);
  if(nextDocumentFingerprint===authorizationDocumentFingerprint&&nextState===authorizationState){
    scheduleAuthorizationExpiry(allowed);
    return;
  }

  // Revoke removed/reassigned channels immediately, before probing additions.
  const retained=new Map([...allowed].filter(([channelId,permission])=>
    next.get(channelId)?.guildId===permission.guildId));
  if(retained.size!==allowed.size){
    allowed=retained;
    const revokedSpool=spool.sweepExpired(allowed);
    const revokedPurge=await purgeExpired(pool,allowed,{allowEmpty:nextErasureOnly||allowed.size===0,exclusive:true});
    console.log("Discord revoked-channel erasure",{
      queuedEventsErased:revokedSpool.eventsErased,
      sourceRowsErased:revokedPurge.rowsErased,
      tombstonesQueued:revokedPurge.tombstonesQueued,
    });
  }

  const newlyAuthorized=new Map([...next].filter(([channelId,permission])=>
    allowed.get(channelId)?.guildId!==permission.guildId));
  if(newlyAuthorized.size>0){
    let report;
    try{report=await verifyPermissions(newlyAuthorized)}
    catch(error){
      if(isTransientDiscordRestError(error)||error?.code==="discord_rest_scheduler_queue_full"){
        await pauseForPermissionPreflight({
          errorCode:Number(error?.status??error?.statusCode)===429?"discord_rate_limited":"discord_api_unavailable",
          guilds:[],
        });
        return;
      }
      throw error;
    }
    if(!report.ok){
      if(isTransientPermissionPreflightReport(report)){
        await pauseForPermissionPreflight(report);
        return;
      }
      throw new Error("New Discord channels failed permission preflight");
    }
    console.log("New Discord channel permission preflight passed",permissionPreflightSummary(report));
  }

  // Snapshot recovery watermarks before newly authorized channels become live.
  for(const channelId of next.keys()){
    if(!allowed.has(channelId))
      recoveryBaselines.set(channelId,await getRecoveryBaseline(pool,channelId));
  }
  allowed=next;
  erasureOnly=nextErasureOnly;
  authorizationDocumentFingerprint=nextDocumentFingerprint;
  authorizationState=nextState;
  scheduleAuthorizationExpiry(allowed);

  const spoolResult=spool.sweepExpired(allowed);
  const purgeResult=await purgeExpired(pool,allowed,{allowEmpty:erasureOnly,exclusive:true});
  console.log("Discord authorization policy reloaded",{
    activeChannels:allowed.size,
    expiredChannels:allowed.expiredChannels.length,
    queuedEventsErased:spoolResult.eventsErased,
    sourceRowsErased:purgeResult.rowsErased,
    erasureTombstonesQueued:purgeResult.tombstonesQueued,
  });
  // If an in-flight replay deferred an event while its lease changed, retry it
  // under the newly committed allowlist before waiting for another Gateway event.
  if(!erasureOnly&&!stopping){
    const pendingDrain=drainPromise;
    if(pendingDrain)await pendingDrain.catch(()=>{});
    if(!stopping)await resumeSpoolAndRecovery();
  }
  if(erasureOnly){
    acceptingEvents=false;
    console.log("No active Discord authorization remains; stopping after erasure");
    void shutdown();
  }
}

function startAuthorizationReload(){
  if(stopping)return;
  if(authorizationReloadRunning){
    authorizationReloadPending=true;
    return;
  }
  authorizationReloadRunning=true;
  authorizationReloadTask=reloadAuthorization().catch(()=>{
    failures++;
    acceptingEvents=false;
    process.exitCode=1;
    console.error("Discord authorization reload failed; collection stopped","authorization_reload_failed");
    void shutdown();
  }).finally(()=>{
    authorizationReloadRunning=false;
    if(authorizationReloadPending&&!stopping){
      authorizationReloadPending=false;
      startAuthorizationReload();
    }
  });
}

function scheduleAuthorizationExpiry(snapshot){
  clearTimeout(authorizationExpiryTimer);
  const deadlines=[...snapshot.values()]
    .map(permission=>Date.parse(permission.expiresAt))
    .filter(value=>Number.isFinite(value));
  if(!deadlines.length)return;
  const nextExpiry=Math.min(...deadlines);
  const delay=Math.min(2_147_000_000,Math.max(1,nextExpiry-Date.now()+100));
  authorizationExpiryTimer=setTimeout(startAuthorizationReload,delay);
  authorizationExpiryTimer.unref();
}

scheduleAuthorizationExpiry(allowed);
authorizationReloadTimer=setInterval(startAuthorizationReload,authorizationReloadMs);
authorizationReloadTimer.unref();

function schedulePermissionPreflightRetry(report){
  if(stopping||permissionPreflightRetryTimer)return;
  const baseMs=permissionPreflightRetryBaseMs(report);
  const delay=retryDelayMs(permissionPreflightRetryAttempt++,{baseMs,maxMs:300_000});
  permissionPreflightRetryTimer=setTimeout(()=>{
    permissionPreflightRetryTimer=null;
    startPermissionPreflight({retry:true});
  },delay);
  permissionPreflightRetryTimer.unref();
}

async function pauseForPermissionPreflight(report){
  if(stopping)return;
  if(!permissionPreflightPaused){
    permissionPreflightPaused=true;
    recoveryPending=true;
    backfillPendingAfterPreflightPause=true;
    acceptingEvents=false;
    if(spoolReplayRetryTimer){
      clearTimeout(spoolReplayRetryTimer);
      spoolReplayRetryTimer=null;
    }
    permissionPreflightPauseTask=(async()=>{
      const pendingDrain=drainPromise;
      if(pendingDrain)await pendingDrain.catch(()=>{});
      await startupTask.catch(()=>{});
      if(stopping)return;
      coverageTask=(async()=>{
        for(const [channelId,permission] of allowed){
          if(!permissionActive(permission))continue;
          const baseline=await getRecoveryBaseline(pool,channelId);
          recoveryBaselines.set(channelId,baseline);
          const stillAuthorized=()=>{
            const current=allowed.get(channelId);
            return permissionActive(current)&&sameAuthorizationLease(current,permission);
          };
          await recordRecoveryCheck(pool,permission.guildId,channelId,baseline,{status:"failed"},stillAuthorized);
        }
      })().catch(()=>{
        throw new Error("permission_preflight_gap_checkpoint_failed");
      });
      await coverageTask;
      console.warn("Discord permission preflight unavailable; collection paused without discarding the spool",{
        errorCode:report?.errorCode??"discord_api_unavailable",
        channels:allowed.size,
        pendingEvents:spool.pendingCount,
        pendingBytes:spool.pendingBytes,
      });
    })();
  }
  await permissionPreflightPauseTask;
  schedulePermissionPreflightRetry(report);
}

function stopAfterPermissionPreflightFailure(){
  if(stopping)return;
  failures++;
  acceptingEvents=false;
  process.exitCode=1;
  console.error("Discord permission preflight failed; collection stopped",{
    code:"permission_preflight_failed",rateLimitResponses:restRateLimitResponses,
  });
  void shutdown();
}

function startPermissionPreflight({retry=false}={}){
  if(stopping||permissionPreflightRunning||permissionPreflightRetryTimer||
     (permissionPreflightPaused&&!retry))return;
  void verifyPermissions(allowed).then(async report=>{
    if(!report.ok){
      if(isTransientPermissionPreflightReport(report)){
        await pauseForPermissionPreflight(report);
        return;
      }
      throw new Error("Discord channel permission check failed");
    }
    if(permissionPreflightPaused){
      await startupTask.catch(()=>{});
      if(stopping)return;
      permissionPreflightPaused=false;
      permissionPreflightRetryAttempt=0;
      acceptingEvents=true;
      console.log("Discord permission preflight recovered; collection resumed",{
        checkedChannels:report.checkedChannels,
        checkedGuilds:report.checkedGuilds,
        pendingEvents:spool.pendingCount,
      });
      if(clientReadySeen&&client.isReady())
        await resumeSpoolAndRecovery();
      return;
    }
    console.log("Discord periodic permission preflight passed",{
      checkedChannels:report.checkedChannels,
      checkedGuilds:report.checkedGuilds,
      rateLimitResponses:restRateLimitResponses,
    });
  }).catch(error=>{
    if(stopping)return;
    if(isTransientDiscordRestError(error)||error?.code==="discord_rest_scheduler_queue_full"){
      void pauseForPermissionPreflight({
        errorCode:Number(error?.status??error?.statusCode)===429?"discord_rate_limited":"discord_api_unavailable",
        guilds:[],
      }).catch(()=>stopAfterPermissionPreflightFailure());
      return;
    }
    stopAfterPermissionPreflightFailure();
  });
}
permissionPreflightTimer=setInterval(startPermissionPreflight,permissionPreflightIntervalMs);
permissionPreflightTimer.unref();

client.once(Events.ClientReady,()=>{
  clientReadySeen=true;
  startupTask=(async()=>{
    console.log("Collector connected",{channels:allowed.size,pendingIngressEvents:spool.pendingCount});
    // Replay durable Gateway events before optional history reconciliation.
    await drainSpool();
    if(stopping)return;
    await recoverRecentGaps();
    if(!permissionPreflightPaused)recoveryPending=false;
    await runConfiguredBackfill();
    if(!permissionPreflightPaused)backfillPendingAfterPreflightPause=false;
    if(!stopping)await drainSpool();
  })();
  void startupTask.catch(()=>{
    failures++;
    acceptingEvents=false;
    process.exitCode=1;
    console.error("Discord startup synchronization failed","startup_sync_failed");
    void shutdown();
  });
});

backlogTimer=setInterval(()=>{
  if(spool.pendingCount>0)
    console.warn("Discord durable ingress backlog",{events:spool.pendingCount,bytes:spool.pendingBytes});
},60_000);
backlogTimer.unref();

sweepTimer=setInterval(()=>{
  if(sweepRunning||stopping)return;
  sweepRunning=true;
  sweepTask=(async()=>{
    const spoolResult=spool.sweepExpired(allowed);
    const result=await purgeExpired(pool,allowed,{allowEmpty:erasureOnly});
    if(result.rowsErased>0||spoolResult.eventsErased>0)
      console.log("Expired/revoked Discord data erased",{
        sourceRows:result.rowsErased,
        sourceTombstonesQueued:result.tombstonesQueued,
        pendingIngressEvents:spoolResult.eventsErased,
      });
  })().catch(()=>{
    failures++;
    acceptingEvents=false;
    process.exitCode=1;
    console.error("Fatal retention enforcement failure","retention_enforcement_failed");
    void shutdown();
  }).finally(()=>{sweepRunning=false;});
},15*60_000);
sweepTimer.unref();

async function shutdown(){
  if(shutdownPromise)return shutdownPromise;
  stopping=true;
  // Keep durable ingress enabled until Gateway destruction completes. Any
  // dispatch delivered while the WebSocket is closing must still reach Spool.
  clearInterval(sweepTimer);
  clearInterval(backlogTimer);
  clearInterval(authorizationReloadTimer);
  clearInterval(permissionPreflightTimer);
  clearTimeout(authorizationExpiryTimer);
  clearTimeout(permissionPreflightRetryTimer);
  permissionPreflightRetryTimer=null;
  clearTimeout(spoolReplayRetryTimer);
  spoolReplayRetryTimer=null;
  shutdownPromise=(async()=>{
    try{await client.destroy()}
    catch{
      failures++;
      process.exitCode=1;
      console.error("Discord Gateway shutdown failed","gateway_shutdown_failed");
    }finally{
      // No more Gateway dispatches can arrive after destroy settles. Close the
      // ingress gate only now; replay itself is already paused by stopping.
      acceptingEvents=false;
    }
    const settled=await Promise.allSettled([
      startupTask,sweepTask,coverageTask,fatalCoverageTask,permissionPreflightPauseTask,
      drainPromise??Promise.resolve(),authorizationReloadTask,permissionPreflightTask,
    ]);
    if(settled.some(result=>result.status==="rejected")){
      failures++;
      process.exitCode=1;
      console.error("Discord in-flight work failed during shutdown","shutdown_task_failed");
    }
    try{spool.close()}
    catch{
      failures++;
      process.exitCode=1;
      console.error("Discord ingress spool close/fsync failed","ingress_spool_close_failed");
    }
    try{await releaseSourceDatabase()}
    catch{
      failures++;
      process.exitCode=1;
      console.error("Discord source database release failed","source_database_release_failed");
    }
    if(failures)process.exitCode=1;
  })();
  return shutdownPromise;
}
process.on("SIGINT",()=>void shutdown());
process.on("SIGTERM",()=>void shutdown());
// Free a recovered backlog before opening the Gateway. Events that need REST
// hydration are explicitly marked as coverage gaps rather than blocking login.
try{
  await drainSpool({allowHydration:false});
}catch{
  await shutdown();
  throw new Error("Pre-login durable ingress replay failed; pending records were retained");
}
if(stopping)throw new Error("Collector stopped before Gateway login");
while(authorizationReloadRunning){
  const activeReload=authorizationReloadTask;
  await activeReload.catch(()=>{});
}
if(stopping)throw new Error("Collector stopped during authorization reload");
try{
  const currentAuthorizationDocument=await readAuthorizationFile(authorizationPath);
  if(JSON.stringify(currentAuthorizationDocument)!==authorizationDocumentFingerprint)
    throw new Error("authorization_changed_before_gateway_login");
}catch{
  failures++;
  acceptingEvents=false;
  process.exitCode=1;
  await shutdown();
  throw new Error("Authorization changed or became unreadable before Gateway login");
}
try{
  await client.login(botToken);
}catch{
  failures++;
  acceptingEvents=false;
  process.exitCode=1;
  console.error("Discord Gateway login failed","gateway_login_failed");
  await shutdown();
  throw new Error("Discord Gateway login failed");
}
