import {readFile} from "node:fs/promises";
import {Client,GatewayIntentBits,Events,Partials} from "discord.js";
import pg from "pg";
import {validateAuthorization,normalizeMessage,allowedObservation} from "./events.mjs";
import {installSchema,storeObservation,getBackfillCursor,advanceBackfillCursor,purgeExpired,getRecoveryBaseline,recordRecoveryCheck} from "./storage.mjs";
import {scanRecentGap} from "./reconcile.mjs";
import {IngressSpool,parseIngressSpoolKey} from "./ingress-spool.mjs";

if(process.env.DISCORD_COLLECTOR_ENABLED!=="true"){
  console.error("Disabled: DISCORD_COLLECTOR_ENABLED is not true");
  process.exit(0);
}
for(const key of ["DISCORD_BOT_TOKEN","DISCORD_SOURCE_DATABASE_URL","DISCORD_AUTHORIZATION_PATH",
  "DISCORD_INGRESS_SPOOL_DIR","DISCORD_INGRESS_SPOOL_KEY"]){
  if(!process.env[key])throw new Error("Missing config: "+key);
}
const botToken=process.env.DISCORD_BOT_TOKEN;
const sourceDatabaseUrl=process.env.DISCORD_SOURCE_DATABASE_URL;
const authorizationPath=process.env.DISCORD_AUTHORIZATION_PATH;
const spoolDirectory=process.env.DISCORD_INGRESS_SPOOL_DIR;
const doc=JSON.parse(await readFile(authorizationPath,"utf8"));
const allowed=validateAuthorization(doc);
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

const pool=new pg.Pool({connectionString:sourceDatabaseUrl,max:4,connectionTimeoutMillis:10_000,keepAlive:true,application_name:"potapoff-discord-collector"});
const singletonClient=await pool.connect().catch(async error=>{spoolKey.fill(0);await pool.end();throw error});
let singletonLockHeld=false;
let spool=null;
const recoveryBaselines=new Map();
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
  // Remove revoked or expired pending payloads before Gateway login.
  const startupSpoolSweep=spool.sweepExpired(allowed);
  if(startupSpoolSweep.eventsErased>0)
    console.log("Expired/revoked ingress events erased",{events:startupSpoolSweep.eventsErased});
  // Schema, retention controls and recovery watermarks must be ready before Gateway login.
  await installSchema(pool);
  await purgeExpired(pool,allowed);
  for(const channelId of allowed.keys())
    recoveryBaselines.set(channelId,await getRecoveryBaseline(pool,channelId));
}catch(error){
  spoolKey.fill(0);
  try{spool?.close()}catch{}
  if(singletonLockHeld){
    try{await singletonClient.query("SELECT pg_advisory_unlock(hashtextextended('potapoff:discord-collector:singleton',0))")}catch{}
  }
  singletonClient.release();
  await pool.end();
  throw error;
}
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

async function record(message,kind){
  const channelId=String(message.channelId??message.channel?.id??"");
  const permission=allowed.get(channelId);
  if(!permission)return {status:"not-allowed"};
  const observation=normalizeMessage(message,kind,new Date().toISOString(),permission.guildId);
  if(!allowedObservation(allowed,observation))return {status:"not-allowed"};
  return await storeObservation(pool,observation,permission.retentionDays);
}

async function persistCoverageGap(channelId){
  const permission=allowed.get(channelId);
  if(!permission)return;
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
  if(!permission)return;
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
  if(!permission||permission.guildId!==event.guildId)return; // Current allowlist wins over queued data.

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
    (!event.createdAt||(event.kind==="edited"&&(!event.editedAt||event.content===null)));
  if(needsHydration&&!allowHydration){
    await recordRecoveryCheck(pool,permission.guildId,event.channelId,
      recoveryBaselines.get(event.channelId)??null,{status:"failed"});
    failures++;
    process.exitCode=1;
    console.error("Pre-login Discord event lacks enough source fields; coverage marked failed",event.kind);
    return;
  }
  if(needsHydration){
    try{
      const channel=await client.channels.fetch(event.channelId);
      if(!channel?.messages)throw new Error("Authorized Discord channel history is unavailable");
      message=await channel.messages.fetch(event.messageId);
    }catch(error){
      if(!isUnknownDiscordMessage(error))throw error;
      // A deleted message may no longer be fetchable. Record the coverage gap,
      // then continue so a queued delete event behind it can still be applied.
      await recordRecoveryCheck(pool,permission.guildId,event.channelId,
        recoveryBaselines.get(event.channelId)??null,{status:"failed"});
      failures++;
      process.exitCode=1;
      console.error("Discord ingress event could not be hydrated; coverage marked failed",event.kind);
      return;
    }
  }
  const observation=normalizeMessage(message,event.kind,event.receivedAt,event.guildId);
  if(!allowedObservation(allowed,observation))return;
  await storeObservation(pool,observation,permission.retentionDays);
}

function drainSpool({allowHydration=true}={}){
  if(drainPromise)return drainPromise;
  drainPromise=(async()=>{
    while(acceptingEvents&&spool.pendingCount>0){
      const batch=spool.listPending(100);
      for(const entry of batch){
        if(!acceptingEvents)break;
        await processSpoolEntry(entry,{allowHydration});
        // PostgreSQL commits before the local event is acknowledged. If the
        // process crashes before unlink, the idempotent source transaction replays.
        spool.ack(entry.sequence);
      }
      spool.flushAcks();
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
    const page=await channel.messages.fetch({limit:requested,...(cursor?{before:cursor}:{})});
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
          const channel=await client.channels.fetch(channelId);
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
    const result=await purgeExpired(pool,allowed);
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
  shutdownPromise=(async()=>{
    try{await client.destroy()}finally{
      await Promise.allSettled([startupTask,sweepTask,coverageTask,drainPromise??Promise.resolve()]);
      try{spool.close()}finally{
        try{
          if(singletonLockHeld)await singletonClient.query("SELECT pg_advisory_unlock(hashtextextended('potapoff:discord-collector:singleton',0))");
          singletonLockHeld=false;
          singletonClient.release();
        }catch(error){
          singletonLockHeld=false;
          singletonClient.release(error);
        }
        await pool.end();
      }
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
