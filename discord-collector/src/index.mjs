import {readAuthorizationFile} from "./authorization-file.mjs";
import {Client,GatewayIntentBits,Events,Partials} from "discord.js";
import pg from "pg";
import {validateAuthorization,normalizeMessage,allowedObservation} from "./events.mjs";
import {installSchema,storeObservation,getBackfillCursor,advanceBackfillCursor,purgeExpired,getRecoveryBaseline,recordRecoveryCheck,recordCoverageFailure} from "./storage.mjs";
import {replaySpoolEntry} from "./spool-replay.mjs";
import {scanRecentGap} from "./reconcile.mjs";
import {IngressSpool,parseIngressSpoolKey} from "./ingress-spool.mjs";
import {runDiscordPermissionPreflight} from "./permission-preflight.mjs";
import {DiscordRestScheduler} from "./rest-scheduler.mjs";

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
const restMinIntervalMs=Number(process.env.DISCORD_REST_MIN_INTERVAL_MS||25);
if(!Number.isInteger(restMinIntervalMs)||restMinIntervalMs<0||restMinIntervalMs>1000)
  throw new RangeError("DISCORD_REST_MIN_INTERVAL_MS must be in 0..1000");
const restMaxQueue=Number(process.env.DISCORD_REST_MAX_QUEUE||20_000);
if(!Number.isInteger(restMaxQueue)||restMaxQueue<1||restMaxQueue>100_000)
  throw new RangeError("DISCORD_REST_MAX_QUEUE must be in 1..100000");
const restScheduler=new DiscordRestScheduler({minIntervalMs:restMinIntervalMs,maxQueue:restMaxQueue});
const permissionPreflightIntervalMs=Number(process.env.DISCORD_PERMISSION_PREFLIGHT_INTERVAL_MS||300_000);
if(!Number.isInteger(permissionPreflightIntervalMs)||permissionPreflightIntervalMs<60_000||permissionPreflightIntervalMs>900_000)
  throw new RangeError("DISCORD_PERMISSION_PREFLIGHT_INTERVAL_MS must be in 60000..900000");
if(allowed.size>0&&process.env.DISCORD_PERMISSION_PREFLIGHT_ENABLED!=="true")
  throw new Error("DISCORD_PERMISSION_PREFLIGHT_ENABLED=true is mandatory before Gateway login");
if(allowed.size>0&&process.env.DISCORD_MESSAGE_CONTENT_INTENT_CONFIRMED!=="true")
  throw new Error("Confirm the approved Message Content intent with DISCORD_MESSAGE_CONTENT_INTENT_CONFIRMED=true");

const pool=new pg.Pool({connectionString:sourceDatabaseUrl,max:4,connectionTimeoutMillis:10_000,keepAlive:true,application_name:"potapoff-discord-collector"});
const singletonClient=await pool.connect().catch(async error=>{spoolKey.fill(0);await pool.end();throw error});
let singletonLockHeld=false;
let spool=null;
const recoveryBaselines=new Map();
let startupSpoolSweep={eventsErased:0};
let startupPurge={rowsErased:0,tombstonesQueued:0};
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
try{
  initialPermissionReport=await runDiscordPermissionPreflight({
    authorization:allowed,
    token:botToken,
    maxChannels:permissionPreflightMaxChannels,
  });
  if(!initialPermissionReport.ok)
    throw new Error("Discord permission preflight rejected one or more authorized channels");
}catch{
  const failureCodes=[...new Set((initialPermissionReport?.guilds??[])
    .flatMap(group=>group.channels.map(channel=>channel.errorCode).filter(Boolean)))];
  console.error("Discord permission preflight failed; Gateway login was not attempted",{
    status:initialPermissionReport?.status??"error",
    checkedChannels:initialPermissionReport?.checkedChannels??allowed.size,
    failedChannels:initialPermissionReport?.failedChannels??allowed.size,
    errorCodes:failureCodes,
    errorCode:initialPermissionReport?.errorCode??"permission_preflight_failed",
  });
  try{spool.close()}finally{await releaseSourceDatabase()}
  throw new Error("Discord permission preflight failed; collection remains stopped");
}
console.log("Discord permission preflight passed",{
  checkedGuilds:initialPermissionReport.checkedGuilds,
  checkedChannels:initialPermissionReport.checkedChannels,
});
const client=new Client({
  intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],
  partials:[Partials.Message,Partials.Channel]
});
let failures=0;
let acceptingEvents=true;
let stopping=false;
let shutdownPromise=null;
let startupTask=Promise.resolve();
let sweepTask=Promise.resolve();
let coverageTask=Promise.resolve();
let drainPromise=null;
let sweepTimer;
let backlogTimer;
let authorizationReloadTimer;
let authorizationExpiryTimer;
let authorizationReloadTask=Promise.resolve();
let permissionPreflightTimer;
let permissionPreflightTask=Promise.resolve();
let permissionPreflightRunning=false;
let permissionPreflightFailed=false;
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
  if(permissionPreflightRunning)await permissionPreflightTask;
  if(permissionPreflightFailed)throw new Error("Discord permission verification already failed");
  permissionPreflightRunning=true;
  const task=runDiscordPermissionPreflight({
    authorization:snapshot,
    token:botToken,
    maxChannels:permissionPreflightMaxChannels,
  });
  permissionPreflightTask=task;
  try{
    const report=await task;
    if(!report.ok)permissionPreflightFailed=true;
    return report;
  }catch(error){
    permissionPreflightFailed=true;
    throw error;
  }finally{
    if(permissionPreflightTask===task)permissionPreflightRunning=false;
  }
}

async function record(message,kind){
  const channelId=String(message.channelId??message.channel?.id??"");
  const permission=allowed.get(channelId);
  if(!permissionActive(permission))return {status:"not-allowed"};
  const observation=normalizeMessage(message,kind,new Date().toISOString(),permission.guildId);
  if(!allowedObservation(allowed,observation))return {status:"not-allowed"};
  return await storeObservation(pool,observation,permission.retentionDays,new Date(),permission.expiresAt);
}

async function persistCoverageGap(channelId){
  const permission=allowed.get(channelId);
  if(!permissionActive(permission))return;
  await recordRecoveryCheck(pool,permission.guildId,channelId,
    recoveryBaselines.get(channelId)??null,{status:"failed"});
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
  return {
    kind,
    messageId:String(message.id??""),
    guildId:String(message.guildId??message.guild?.id??permission.guildId),
    channelId,
    // Without a trustworthy publication timestamp, keep only identifiers needed
    // to hydrate the event later; never retain author/content beyond retention.
    authorId:retainPersonalFields&&message.author?.id?String(message.author.id):null,
    content:retainPersonalFields&&typeof message.content==="string"?message.content:null,
    createdAt,
    editedAt:isoOrNull(message.editedAt,message.editedTimestamp),
    receivedAt:new Date().toISOString(),
  };
}

function failCollector(channelId,code){
  if(!acceptingEvents)return;
  acceptingEvents=false;
  failures++;
  process.exitCode=1;
  console.error("Discord durable ingress stopped",code);
  coverageTask=Promise.resolve().then(()=>persistCoverageGap(channelId)).catch(()=>{
    console.error("Discord coverage gap could not be persisted",channelId);
  });
  void coverageTask.finally(()=>void shutdown());
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
    failCollector(channelId,error?.code==="INGRESS_SPOOL_FULL"?"ingress_spool_full":"ingress_spool_write_failed");
    return;
  }
  if(client.isReady())void drainSpool().catch(()=>{});
}

function isUnknownDiscordMessage(error){
  return error?.code===10008||error?.status===404||error?.rawError?.code===10008;
}

async function processSpoolEntry(entry,{allowHydration=true}={}){
  const event=entry.event;
  const permission=allowed.get(event.channelId);
  const authorized=permissionActive(permission)&&permission.guildId===event.guildId;
  return replaySpoolEntry({
    entry,allowHydration,authorized,
    hydrate:async queued=>{
      const channel=await restScheduler.run("ingress",()=>client.channels.fetch(queued.channelId));
      if(!channel?.messages)throw new Error("Authorized Discord channel history is unavailable");
      return await restScheduler.run("ingress",()=>channel.messages.fetch(queued.messageId));
    },
    store:async(message,kind,queued)=>{
      const observation=normalizeMessage(message,kind,queued.receivedAt,queued.guildId);
      if(!allowedObservation(allowed,observation))return;
      const currentPermission=allowed.get(queued.channelId);
      if(!permissionActive(currentPermission)||currentPermission.guildId!==queued.guildId)return;
      await storeObservation(pool,observation,currentPermission.retentionDays,
        new Date(),currentPermission.expiresAt);
    },
    recordCoverageFailure:async(queued,reason,sequence)=>{
      await recordCoverageFailure(pool,queued,reason,sequence);
      await recordRecoveryCheck(pool,queued.guildId,queued.channelId,
        recoveryBaselines.get(queued.channelId)??null,{status:"failed"});
      failures++;
      process.exitCode=1;
      console.error("Discord ingress coverage gap recorded",{
        eventKind:queued.kind,reason,
      });
    },
  });
}

function drainSpool({allowHydration=true}={}){
  if(drainPromise)return drainPromise;
  drainPromise=(async()=>{
    while(acceptingEvents&&spool.pendingCount>0){
      const batch=spool.listPending(100);
      for(const entry of batch){
        if(!acceptingEvents)break;
        const outcome=await processSpoolEntry(entry,{allowHydration});
        if(outcome?.ack!==true){
          // Keep the original encrypted event until Gateway/REST hydration is
          // available. The ClientReady replay will retry this exact sequence.
          break;
        }
        // PostgreSQL commits before the local event is acknowledged. If the
        // process crashes before unlink, the idempotent source transaction replays.
        spool.ack(entry.sequence);
      }
      spool.flushAcks();
      if(!allowHydration&&spool.pendingCount>0&&
         batch.some(entry=>entry.event.kind!=="deleted"&&
           (!entry.event.createdAt||(entry.event.kind==="edited"&&(!entry.event.editedAt||entry.event.content===null))))){
        break;
      }
      if(spool.pendingCount>0)await new Promise(resolve=>setImmediate(resolve));
    }
  })().catch(error=>{
    const oldest=spool.oldestPending;
    failures++;
    acceptingEvents=false;
    process.exitCode=1;
    console.error("Discord durable ingress replay stopped; event retained for restart",
      error?.code??"ingress_replay_failed");
    coverageTask=Promise.resolve().then(()=>
      oldest?persistCoverageGap(oldest.event.channelId):undefined
    ).catch(()=>console.error("Discord replay coverage gap could not be persisted"));
    void coverageTask.finally(()=>void shutdown());
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

async function backfill(guildId,channelId,maxMessages){
  const channel=await client.channels.fetch(channelId);
  if(!channel?.messages)throw new Error("Channel not accessible for history");
  let cursor=await getBackfillCursor(pool,channelId);
  let count=0;
  while(count<maxMessages&&!stopping){
    const requested=Math.min(100,maxMessages-count);
    const page=await restScheduler.run("backfill",()=>channel.messages.fetch({limit:requested,...(cursor?{before:cursor}:{})}));
    if(page.size===0)break;
    const ordered=[...page.values()].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
    for(const message of ordered){
      if(stopping)break;
      await record(message,"observed");
      count++;
    }
    if(stopping)break;
    cursor=ordered[0].id;
    // Cursor never advances past a failed page; successful rows replay idempotently.
    await advanceBackfillCursor(pool,guildId,channelId,cursor);
    if(page.size<requested)break;
  }
  console.log("History sync pass",{channelId,processed:count});
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
    const revokedPurge=await purgeExpired(pool,allowed,{allowEmpty:nextErasureOnly||allowed.size===0});
    console.log("Discord revoked-channel erasure",{
      queuedEventsErased:revokedSpool.eventsErased,
      sourceRowsErased:revokedPurge.rowsErased,
      tombstonesQueued:revokedPurge.tombstonesQueued,
    });
  }

  const newlyAuthorized=new Map([...next].filter(([channelId,permission])=>
    allowed.get(channelId)?.guildId!==permission.guildId));
  if(newlyAuthorized.size>0){
    const report=await verifyPermissions(newlyAuthorized);
    if(!report.ok)throw new Error("New Discord channels failed permission preflight");
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
  const purgeResult=await purgeExpired(pool,allowed,{allowEmpty:erasureOnly});
  console.log("Discord authorization policy reloaded",{
    activeChannels:allowed.size,
    expiredChannels:allowed.expiredChannels.length,
    queuedEventsErased:spoolResult.eventsErased,
    sourceRowsErased:purgeResult.rowsErased,
    erasureTombstonesQueued:purgeResult.tombstonesQueued,
  });
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

function startPermissionPreflight(){
  if(stopping||permissionPreflightRunning)return;
  void verifyPermissions(allowed).then(report=>{
    if(!report.ok)throw new Error("Discord channel permission check failed");
    console.log("Discord periodic permission preflight passed",{
      checkedChannels:report.checkedChannels,
      checkedGuilds:report.checkedGuilds,
    });
  }).catch(()=>{
    if(stopping)return;
    failures++;
    acceptingEvents=false;
    process.exitCode=1;
    console.error("Discord permission preflight failed; collection stopped","permission_preflight_failed");
    void shutdown();
  });
}
permissionPreflightTimer=setInterval(startPermissionPreflight,permissionPreflightIntervalMs);
permissionPreflightTimer.unref();

client.once(Events.ClientReady,()=>{
  startupTask=(async()=>{
    console.log("Collector connected",{channels:allowed.size,pendingIngressEvents:spool.pendingCount});
    // Replay durable Gateway events before optional history reconciliation.
    await drainSpool();
    if(stopping)return;
    if(process.env.DISCORD_GAP_RECOVERY_ENABLED==="true"){
      for(const [channelId,permission] of allowed){
        if(stopping)break;
        const baseline=recoveryBaselines.get(channelId)??null;
        try{
          const channel=await restScheduler.run("recovery",()=>client.channels.fetch(channelId));
          const result=await scanRecentGap({
            channel,baselineMessageId:baseline,maxPages:recoveryMaxPages,
            onMessage:message=>record(message,"observed")
          });
          await recordRecoveryCheck(pool,permission.guildId,channelId,baseline,result);
          console.log("Discord recovery window",{channelId,status:result.status,
            pages:result.pagesScanned,processed:result.messagesProcessed});
        }catch(error){
          failures++;
          try{
            await recordRecoveryCheck(pool,permission.guildId,channelId,baseline,{status:"failed"});
          }catch{
            console.error("Recovery failure status could not be saved",channelId);
            process.exitCode=1;
            void shutdown();
          }
          console.error("Discord gap recovery failed",channelId,error?.code??"recovery_failed");
        }
      }
    }
    const max=Number(process.env.DISCORD_BACKFILL_MAX_MESSAGES||0);
    if(process.env.DISCORD_BACKFILL_ENABLED!=="true"||!Number.isInteger(max)||max<=0)return;
    for(const [channelId,permission] of allowed){
      if(stopping)break;
      try{await backfill(permission.guildId,channelId,max)}
      catch(error){failures++;console.error("History backfill failed",channelId,error?.code??"backfill_failed")}
    }
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
  acceptingEvents=false;
  clearInterval(sweepTimer);
  clearInterval(backlogTimer);
  clearInterval(authorizationReloadTimer);
  clearInterval(permissionPreflightTimer);
  clearTimeout(authorizationExpiryTimer);
  shutdownPromise=(async()=>{
    try{await client.destroy()}finally{
      await Promise.allSettled([startupTask,sweepTask,coverageTask,drainPromise??Promise.resolve(),authorizationReloadTask,permissionPreflightTask]);
      try{spool.close()}finally{await releaseSourceDatabase()}
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
