import {readFile} from "node:fs/promises";
import {Client,GatewayIntentBits,Events,Partials} from "discord.js";
import pg from "pg";
import {validateAuthorization,normalizeMessage,allowedObservation} from "./events.mjs";
import {installSchema,storeObservation,getBackfillCursor,advanceBackfillCursor,purgeExpired,getRecoveryBaseline,recordRecoveryCheck} from "./storage.mjs";
import {scanRecentGap} from "./reconcile.mjs";
import {emitDiscordOutbox} from "./outbox.mjs";

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
async function record(message,kind){
  const channelId=String(message.channelId??message.channel?.id??"");
  const permission=allowed.get(channelId);
  if(!permission)return {status:"not-allowed"};
  const observation=normalizeMessage(message,kind,new Date().toISOString(),permission.guildId);
  if(!allowedObservation(allowed,observation))return {status:"not-allowed"};
  return await storeObservation(pool,observation,permission.retentionDays,new Date(),emitDiscordOutbox);
}
function safeRecord(message,kind){
  void record(message,kind).catch(error=>{
    failures++;
    console.error("Discord event handling failed",kind,error?.message);
  });
}
client.on(Events.MessageCreate,msg=>safeRecord(msg,"observed"));
client.on(Events.MessageUpdate,(_before,after)=>{
  void (async()=>{
    if(after.partial)after=await after.fetch();
    await record(after,"edited");
  })().catch(error=>{failures++;console.error("Discord update failed",error?.message)});
});
client.on(Events.MessageDelete,msg=>safeRecord(msg,"deleted"));

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
client.once(Events.ClientReady,async()=>{
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
});
const sweepTimer=setInterval(()=>{
  void purgeExpired(pool,allowed).then(result=>{
    if(result.rowsErased>0)console.log("Expired/revoked data erased",{rows:result.rowsErased});
  }).catch(error=>{
    console.error("Fatal retention enforcement failure",error?.message);
    process.exitCode=1;
    void shutdown();
  });
},15*60_000);
sweepTimer.unref();
let stopping=false;
async function shutdown(){
  if(stopping)return;
  stopping=true;
  clearInterval(sweepTimer);
  try{await client.destroy()}finally{await pool.end()}
  if(failures)process.exitCode=1;
}
process.on("SIGINT",()=>void shutdown());
process.on("SIGTERM",()=>void shutdown());
await client.login(process.env.DISCORD_BOT_TOKEN);
