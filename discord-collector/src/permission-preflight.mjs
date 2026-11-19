import {isDiscordSnowflake} from "@claude-project/contracts";

const API_BASE_URL="https://discord.com/api/v10";
const USER_VIEW_CHANNEL=1n<<10n;
const USER_READ_MESSAGE_HISTORY=1n<<16n;
const USER_ADMINISTRATOR=1n<<3n;
const USER_SEND_MESSAGES=1n<<11n;
const REQUIRED_READ_PERMISSIONS=USER_VIEW_CHANNEL|USER_READ_MESSAGE_HISTORY;
const SUPPORTED_CHANNEL_TYPES=new Set([0,5]); // Guild text and announcement channels.
const MAX_AUTHORIZATION_CHANNELS=10_000;

class DiscordApiError extends Error {
  constructor(code,status=null){
    super(code);
    this.name="DiscordApiError";
    this.code=code;
    this.status=status;
  }
}

async function safeCancel(response){
  try{await response?.body?.cancel?.()}catch{}
}

function validateOptions({token,authorization,fetchImpl,timeoutMs,maxRetries,maxRetryDelayMs,maxChannels}){
  if(typeof token!=="string"||!token.trim())throw new TypeError("A Discord bot token is required");
  if(!(authorization instanceof Map)||authorization.size<1)
    throw new TypeError("A nonempty validated authorization map is required");
  if(typeof fetchImpl!=="function")throw new TypeError("A fetch implementation is required");
  if(!Number.isInteger(timeoutMs)||timeoutMs<1_000||timeoutMs>30_000)
    throw new RangeError("timeoutMs must be in 1000..30000");
  if(!Number.isInteger(maxRetries)||maxRetries<0||maxRetries>3)
    throw new RangeError("maxRetries must be in 0..3");
  if(!Number.isInteger(maxRetryDelayMs)||maxRetryDelayMs<0||maxRetryDelayMs>30_000)
    throw new RangeError("maxRetryDelayMs must be in 0..30000");
  if(!Number.isInteger(maxChannels)||maxChannels<1||maxChannels>MAX_AUTHORIZATION_CHANNELS)
    throw new RangeError("maxChannels must be in 1..10000");
}

async function retryAfterMs(response){
  const header=response?.headers?.get?.("retry-after");
  if(header!==null&&header!==undefined&&header.trim()!==""){
    const seconds=Number(header);
    if(Number.isFinite(seconds)&&seconds>=0)return Math.ceil(seconds*1000);
  }
  try{
    const body=await response.json();
    const seconds=Number(body?.retry_after);
    if(Number.isFinite(seconds)&&seconds>=0)return Math.ceil(seconds*1000);
  }catch{}
  return null;
}

async function requestJson(path,{token,fetchImpl,baseUrl,timeoutMs,maxRetries,maxRetryDelayMs,sleep}){
  let normalizedBaseUrl=baseUrl;
  while(normalizedBaseUrl.endsWith("/"))normalizedBaseUrl=normalizedBaseUrl.slice(0,-1);
  const url=normalizedBaseUrl+path;
  for(let attempt=0;attempt<=maxRetries;attempt++){
    let response;
    try{
      response=await fetchImpl(url,{
        method:"GET",
        headers:{
          Authorization:"Bot "+token,
          Accept:"application/json",
          "User-Agent":"DiscordBot (https://github.com/vyborovamaria3-maker/claude-project, 0.1.0)",
        },
        signal:AbortSignal.timeout(timeoutMs),
      });
    }catch{
      throw new DiscordApiError("discord_api_unavailable");
    }

    if(response.status===429){
      const waitMs=await retryAfterMs(response);
      await safeCancel(response);
      if(attempt>=maxRetries||waitMs===null||waitMs>maxRetryDelayMs)
        throw new DiscordApiError("discord_rate_limited",429);
      await sleep(waitMs);
      continue;
    }

    if(response.status>=500&&response.status<=599){
      await safeCancel(response);
      if(attempt>=maxRetries)throw new DiscordApiError("discord_api_unavailable",response.status);
      await sleep(Math.min(1_000,250*(attempt+1)));
      continue;
    }

    if(response.status===401){
      await safeCancel(response);
      throw new DiscordApiError("invalid_bot_token",401);
    }
    if(response.status===403){
      await safeCancel(response);
      throw new DiscordApiError("discord_forbidden",403);
    }
    if(response.status===404){
      await safeCancel(response);
      throw new DiscordApiError("discord_not_found",404);
    }
    if(!response.ok){
      await safeCancel(response);
      throw new DiscordApiError("discord_api_error",response.status);
    }

    try{
      return await response.json();
    }catch{
      await safeCancel(response);
      throw new DiscordApiError("discord_invalid_response",response.status);
    }
  }
  throw new DiscordApiError("discord_api_unavailable");
}

function failedChannel(channelId,errorCode){
  return {
    channelId,
    status:"failed",
    channelType:null,
    checks:{viewChannel:false,readMessageHistory:false},
    errorCode,
  };
}

function permissionBits(value){
  if(typeof value!=="string"||!/^[0-9]+$/.test(value))return null;
  try{return BigInt(value)}catch{return null}
}

function channelResult(channelId,channelType,bits){
  if(bits===null)return failedChannel(channelId,"invalid_permission_response");
  const administrator=(bits&USER_ADMINISTRATOR)!==0n;
  const sendMessages=(bits&USER_SEND_MESSAGES)!==0n;
  const viewChannel=(bits&USER_VIEW_CHANNEL)!==0n;
  const readMessageHistory=(bits&USER_READ_MESSAGE_HISTORY)!==0n;
  const hasUnnecessaryPermissions=(bits&~REQUIRED_READ_PERMISSIONS)!==0n;
  const errorCode=administrator?"excessive_administrator_permission":
    hasUnnecessaryPermissions?"unnecessary_permissions_granted":
    !viewChannel?"view_channel_missing":
    !readMessageHistory?"read_message_history_missing":null;
  return {
    channelId,
    status:errorCode?"failed":"passed",
    channelType,
    checks:{viewChannel,readMessageHistory,administrator,sendMessages,leastPrivilege:!hasUnnecessaryPermissions},
    errorCode,
  };
}

function makeReport({checkedAt,botId=null,groups,topLevelError=null}){
  const channels=groups.flatMap(group=>group.channels);
  const failedChannels=channels.filter(channel=>channel.status!=="passed").length;
  return {
    version:1,
    status:topLevelError||failedChannels>0?"failed":"passed",
    ok:!topLevelError&&failedChannels===0,
    checkedAt,
    botId,
    checkedGuilds:groups.length,
    checkedChannels:channels.length,
    passedChannels:channels.length-failedChannels,
    failedChannels,
    errorCode:topLevelError,
    guilds:groups,
  };
}

/**
 * Read-only, allowlist-bounded Discord permission preflight.
 *
 * It lists only channels visible to the bot, then asks Discord for the
 * bot member's computed channel permissions. It never fetches message bodies.
 */
export async function runDiscordPermissionPreflight({
  authorization,
  token,
  fetchImpl=globalThis.fetch,
  baseUrl=API_BASE_URL,
  timeoutMs=10_000,
  maxRetries=2,
  maxRetryDelayMs=5_000,
  maxChannels=1_000,
  now=new Date(),
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
}={}){
  validateOptions({token,authorization,fetchImpl,timeoutMs,maxRetries,maxRetryDelayMs,maxChannels});
  let parsedBaseUrl;
  try{parsedBaseUrl=new URL(baseUrl)}catch{throw new TypeError("Discord API base URL is invalid")}
  if(parsedBaseUrl.protocol!=="https:"||parsedBaseUrl.username||parsedBaseUrl.password||
     parsedBaseUrl.search||parsedBaseUrl.hash)
    throw new TypeError("Discord API base URL must use HTTPS without credentials or query parameters");
    throw new TypeError("Discord API base URL must use HTTPS");
  const nowMs=now instanceof Date?now.getTime():Date.parse(now);
  if(!Number.isFinite(nowMs))throw new TypeError("Preflight clock is invalid");
  const checkedAt=new Date(nowMs).toISOString();

  if(authorization.size>maxChannels){
    const groups=[...new Set([...authorization.values()].map(value=>value?.guildId))]
      .filter(Boolean).map(guildId=>({
        guildId,
        status:"failed",
        errorCode:"preflight_channel_limit_exceeded",
        channels:[...authorization.entries()]
          .filter(([,value])=>value?.guildId===guildId)
          .map(([channelId])=>failedChannel(channelId,"preflight_channel_limit_exceeded")),
      }));
    return makeReport({checkedAt,groups,topLevelError:"preflight_channel_limit_exceeded"});
  }

  const grouped=new Map();
  for(const [channelId,permission] of authorization){
    if(!isDiscordSnowflake(channelId)||!permission||
       !isDiscordSnowflake(String(permission.guildId??""))||
       typeof permission.expiresAt!=="string"||
       !Number.isFinite(Date.parse(permission.expiresAt)))
      throw new TypeError("Authorization map contains an invalid channel lease");
    const group=grouped.get(permission.guildId)??[];
    group.push({channelId,permission});
    grouped.set(permission.guildId,group);
  }

  const groups=[...grouped.entries()].map(([guildId,items])=>({
    guildId,
    status:"pending",
    errorCode:null,
    channels:items.map(({channelId,permission})=>
      Date.parse(permission.expiresAt)<=nowMs
        ? failedChannel(channelId,"authorization_expired")
        : {channelId,status:"pending",channelType:null,
           checks:{viewChannel:false,readMessageHistory:false},errorCode:null}),
  }));
  const activeCount=groups.reduce((count,group)=>
    count+group.channels.filter(channel=>channel.errorCode===null).length,0);
  if(activeCount===0)
    return makeReport({checkedAt,groups,topLevelError:"no_active_authorized_channels"});

  let bot;
  try{
    bot=await requestJson("/users/@me",{token,fetchImpl,baseUrl,timeoutMs,maxRetries,maxRetryDelayMs,sleep});
  }catch(error){
    const code=error instanceof DiscordApiError?error.code:"discord_api_unavailable";
    for(const group of groups){
      for(const channel of group.channels)if(channel.status==="pending")Object.assign(channel,failedChannel(channel.channelId,code));
      group.status="failed";
      group.errorCode=code;
    }
    return makeReport({checkedAt,groups,topLevelError:code});
  }
  if(!bot||typeof bot.id!=="string"||!isDiscordSnowflake(bot.id))
    return makeReport({checkedAt,groups,topLevelError:"invalid_bot_identity_response"});

  let stopAfterApiFailure=null;
  for(const group of groups){
    const pending=group.channels.filter(channel=>channel.status==="pending");
    if(pending.length===0){
      group.status="failed";
      group.errorCode=group.channels[0]?.errorCode??"authorization_expired";
      continue;
    }
    if(stopAfterApiFailure){
      for(const channel of pending)Object.assign(channel,failedChannel(channel.channelId,stopAfterApiFailure));
      group.status="failed";
      group.errorCode=stopAfterApiFailure;
      continue;
    }

    let visibleChannels;
    try{
      visibleChannels=await requestJson(
        "/guilds/"+group.guildId+"/channels",
        {token,fetchImpl,baseUrl,timeoutMs,maxRetries,maxRetryDelayMs,sleep},
      );
    }catch(error){
      const code=error instanceof DiscordApiError?error.code:"discord_api_unavailable";
      const mapped=code==="discord_not_found"?"guild_unavailable_or_bot_not_member":
        code==="discord_forbidden"?"guild_access_denied":code;
      for(const channel of pending)Object.assign(channel,failedChannel(channel.channelId,mapped));
      group.status="failed";
      group.errorCode=mapped;
      if(["invalid_bot_token","discord_api_unavailable","discord_rate_limited"].includes(code))
        stopAfterApiFailure=code;
      continue;
    }
    if(!Array.isArray(visibleChannels)){
      for(const channel of pending)Object.assign(channel,failedChannel(channel.channelId,"invalid_guild_channels_response"));
      group.status="failed";
      group.errorCode="invalid_guild_channels_response";
      continue;
    }

    const visibleById=new Map();
    let invalidChannelList=false;
    for(const channel of visibleChannels){
      if(!channel||typeof channel.id!=="string"||!isDiscordSnowflake(channel.id)||
         (channel.guild_id!==undefined&&channel.guild_id!==group.guildId)||
         visibleById.has(channel.id)){
        invalidChannelList=true;
        break;
      }
      visibleById.set(channel.id,channel);
    }
    if(invalidChannelList){
      for(const channel of pending)Object.assign(channel,failedChannel(channel.channelId,"invalid_guild_channels_response"));
      group.status="failed";
      group.errorCode="invalid_guild_channels_response";
      continue;
    }

    for(const result of pending){
      if(stopAfterApiFailure){
        Object.assign(result,failedChannel(result.channelId,stopAfterApiFailure));
        continue;
      }
      const channel=visibleById.get(result.channelId);
      if(!channel){
        Object.assign(result,failedChannel(result.channelId,"channel_not_visible_or_missing"));
        continue;
      }
      if(!SUPPORTED_CHANNEL_TYPES.has(channel.type)){
        Object.assign(result,failedChannel(result.channelId,"unsupported_channel_type"));
        result.channelType=Number.isInteger(channel.type)?channel.type:null;
        continue;
      }

      let permissionResponse;
      try{
        permissionResponse=await requestJson(
          "/channels/"+result.channelId+"/permissions/member/"+bot.id,
          {token,fetchImpl,baseUrl,timeoutMs,maxRetries,maxRetryDelayMs,sleep},
        );
      }catch(error){
        const code=error instanceof DiscordApiError?error.code:"discord_api_unavailable";
        const mapped=code==="discord_forbidden"?"view_channel_denied":
          code==="discord_not_found"?"channel_not_visible_or_missing":code;
        Object.assign(result,failedChannel(result.channelId,mapped));
        if(["invalid_bot_token","discord_api_unavailable","discord_rate_limited"].includes(code))
          stopAfterApiFailure=code;
        continue;
      }
      const bits=permissionBits(permissionResponse?.permissions);
      Object.assign(result,channelResult(result.channelId,channel.type,bits));
    }

    group.status=group.channels.every(channel=>channel.status==="passed")?"passed":"failed";
    group.errorCode=group.channels.find(channel=>channel.status!=="passed")?.errorCode??null;
  }

  return makeReport({checkedAt,botId:bot.id,groups});
}
