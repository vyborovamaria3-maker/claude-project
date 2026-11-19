import {readFile} from "node:fs/promises";
import {Client,GatewayIntentBits,Events,Partials} from "discord.js";
import pg from "pg";
import {validateAuthorization,normalizeMessage,allowedObservation} from "./events.mjs";
import {installSchema,storeObservation,getBackfillCursor,advanceBackfillCursor} from "./storage.mjs";

if(process.env.DISCORD_COLLECTOR_ENABLED!=="true"){
  console.error("Disabled: DISCORD_COLLECTOR_ENABLED is not true");
  process.exit(0);
}
for(const key of ["DISCORD_BOT_TOKEN","DISCORD_SOURCE_DATABASE_URL","DISCORD_AUTHORIZATION_PATH"]){
  if(!process.env[key])throw new Error("Missing config: "+key);
}
const doc=JSON.parse(await readFile(process.env.DISCORD_AUTHORIZATION_PATH,"utf8"));
const allowed=validateAuthorization(doc);
const pool=new pg.Pool({connectionString:process.env.DISCORD_SOURCE_DATABASE_URL,max:4});
await installSchema(pool);
const client=new Client({
  intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],
  partials:[Partials.Message,Partials.Channel]
});
let errors=0;
async function record(message,kind){
  const observation=normalizeMessage(message,kind);
  if(!allowedObservation(allowed,observation))return;
  await storeObservation(pool,observation);
}
function safeRecord(message,kind){
  void record(message,kind).catch(error=>{
    errors++;
    console.error("Discord event handling failed",kind,error?.message);
  });
}
client.on(Events.MessageCreate,msg=>safeRecord(msg,"observed"));
client.on(Events.MessageUpdate,(_before,after)=>{
  void (async()=>{
    if(after.partial)after=await after.fetch();
    await record(after,"edited");
  })().catch(error=>{errors++;console.error("Discord update failed",error?.message)});
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
    // Checkpoint only after a complete, successfully persisted page.
    await advanceBackfillCursor(pool,guildId,channelId,cursor);
    if(page.size<requested)break;
  }
  console.log("History sync pass",{channelId,processed:count});
}
client.once(Events.ClientReady,async()=>{
  console.log("Collector connected",{channels:allowed.size});
  const max=Number(process.env.DISCORD_BACKFILL_MAX_MESSAGES||0);
  if(process.env.DISCORD_BACKFILL_ENABLED!=="true"||!Number.isInteger(max)||max<=0)return;
  for(const [channelId,permission] of allowed){
    try{await backfill(permission.guildId,channelId,max)}
    catch(error){errors++;console.error("History backfill failed",channelId,error?.message)}
  }
});
async function close(){
  await client.destroy();
  await pool.end();
  process.exit(errors?1:0);
}
process.on("SIGINT",()=>void close());
process.on("SIGTERM",()=>void close());
await client.login(process.env.DISCORD_BOT_TOKEN);
