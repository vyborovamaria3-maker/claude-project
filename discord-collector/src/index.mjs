import {readFile} from "node:fs/promises";
import {Client,GatewayIntentBits,Events,Partials} from "discord.js";
import pg from "pg";
import {validateAuthorization,normalizeMessage,allowedObservation} from "./events.mjs";
import {installSchema,storeObservation,getBackfillCursor,advanceBackfillCursor,purgeExpired,getRecoveryBaseline,recordRecoveryCheck} from "./storage.mjs";
import {scanRecentGap} from "./reconcile.mjs";

if(process.env.DISCORD_COLLECTOR_ENABLED!=="true"){
  console.error("Disabled: DISCORD_COLLECTOR_ENABLED is not true");
  process.exit(0);
}
for(const key of ["DISCORD_BOT_TOKEN","DISCORD_SOURCE_DATABASE_URL","DISCORD_AUTHORIZATION_PATH"]){
  if(!process.env[key])throw new Error("Missing config: "+key);
}
const doc=JSON.parse(await readFile(process.env.DISCORD_AUTHORIZATION_PATH,"utf8"));
const allowed=validateAuthorization(doc);
const recoveryMaxPages=Number(process.env.DISCORD_GAP_RECOVERY_MAX_PAGES||5);
if(process.env.DISCORD_GAP_RECOVERY_ENABLED==="true" &&
   (!Number.isInteger(recoveryMaxPages)||recoveryMaxPages<1||recoveryMaxPages>50))
  throw new RangeError("DISCORD_GAP_RECOVERY_MAX_PAGES must be in 1..50");
const maxInFlight=Number(process.env.DISCORD_MAX_IN_FLIGHT_WRITES||256);
if(!Number.isInteger(maxInFlight)||maxInFlight<16||maxInFlight>4096)
  throw new RangeError("DISCORD_MAX_IN_FLIGHT_WRITES must be in 16..4096");
const pool=new pg.Pool({connectionString:process.env.DISCORD_SOURCE_DATABASE_URL,max:4});
await installSchema(pool);
await purgeExpired(pool,allowed); // Startup retention/revocation control, fail-closed if unavailable.
// Snapshot BEFORE Gateway login; live events must not hide missed downtime messages.
const recoveryBaselines=new Map();
for(const channelId of allowed.keys()){
  recoveryBaselines.set(channelId,await getRecoveryBaseline(pool,channelId));
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
let sweepTimer;
let sweepRunning=false;
const inFlight=new Set();

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

function trackTask(kind,message,work){
  if(!acceptingEvents)return;
  const channelId=String(message.channelId??message.channel?.id??"");
  if(inFlight.size>=maxInFlight){
    acceptingEvents=false;
    failures++;
    process.exitCode=1;
    const gap=Promise.resolve().then(()=>persistCoverageGap(channelId))
      .catch(()=>console.error("Discord overload coverage gap could not be persisted",channelId))
      .finally(()=>{inFlight.delete(gap);void shutdown();});
    inFlight.add(gap);
    console.error("Discord ingress stopped after bounded in-flight write limit","ingress_overloaded");
    return;
  }
  let task;
  task=Promise.resolve().then(work).catch(async()=>{
    failures++;
    acceptingEvents=false;
    process.exitCode=1;
    console.error("Discord event persistence failed",kind,"source_write_failed");
    try{await persistCoverageGap(channelId)}
    catch{console.error("Discord coverage gap could not be persisted",channelId)}
    void shutdown();
  }).finally(()=>inFlight.delete(task));
  inFlight.add(task);
}

client.on(Events.MessageCreate,msg=>trackTask("observed",msg,()=>record(msg,"observed")));
client.on(Events.MessageUpdate,(_before,after)=>trackTask("edited",after,async()=>{
  const message=after.partial?await after.fetch():after;
  return record(message,"edited");
}));
client.on(Events.MessageDelete,msg=>trackTask("deleted",msg,()=>record(msg,"deleted")));
client.on(Events.MessageBulkDelete,messages=>{
  for(const message of messages.values())trackTask("deleted",message,()=>record(message,"deleted"));
});

async function backfill(guildId,channelId,maxMessages){
  const channel=await client.channels.fetch(channelId);
  if(!channel?.messages)throw new Error("Channel not accessible for history");
  let cursor=await getBackfillCursor(pool,channelId);
  let count=0;
  while(count<maxMessages){
    const requested=Math.min(100,maxMessages-count);
    const page=await channel.messages.fetch({limit:requested,...(cursor?{before:cursor}:{})});
    if(page.size===0)break;
    const ordered=[...page.values()].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
    for(const message of ordered){await record(message,"observed");count++}
    cursor=ordered[0].id;
    // Cursor never advances past a failed page; successful rows replay idempotently.
    await advanceBackfillCursor(pool,guildId,channelId,cursor);
    if(page.size<requested)break;
  }
  console.log("History sync pass",{channelId,processed:count});
}
client.once(Events.ClientReady,()=>{
  startupTask=(async()=>{
  console.log("Collector connected",{channels:allowed.size});
  if(process.env.DISCORD_GAP_RECOVERY_ENABLED==="true"){
    for(const [channelId,permission] of allowed){
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
        }catch(persistError){
          console.error("Recovery failure status could not be saved",channelId,persistError?.message);
          process.exitCode=1;
          void shutdown(); // Fail closed rather than continue with invisible gaps.
        }
        console.error("Discord gap recovery failed",channelId,error?.message);
      }
    }
  }
  const max=Number(process.env.DISCORD_BACKFILL_MAX_MESSAGES||0);
  if(process.env.DISCORD_BACKFILL_ENABLED!=="true"||!Number.isInteger(max)||max<=0)return;
  for(const [channelId,permission] of allowed){
    try{await backfill(permission.guildId,channelId,max)}
    catch(error){failures++;console.error("History backfill failed",channelId,error?.message)}
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
sweepTimer=setInterval(()=>{
  if(sweepRunning||stopping)return;
  sweepRunning=true;
  sweepTask=purgeExpired(pool,allowed).then(result=>{
    if(result.rowsErased>0)console.log("Expired/revoked data erased",{rows:result.rowsErased});
  }).catch(()=>{
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
  shutdownPromise=(async()=>{
    try{await client.destroy()}finally{
      await Promise.allSettled([...inFlight,startupTask,sweepTask]);
      await pool.end();
    }
    if(failures)process.exitCode=1;
  })();
  return shutdownPromise;
}
process.on("SIGINT",()=>void shutdown());
process.on("SIGTERM",()=>void shutdown());
try{
  await client.login(process.env.DISCORD_BOT_TOKEN);
}catch(error){
  failures++;
  acceptingEvents=false;
  process.exitCode=1;
  console.error("Discord Gateway login failed","gateway_login_failed");
  await shutdown();
  throw error;
}
