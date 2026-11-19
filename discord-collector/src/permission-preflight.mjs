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

function decimalPermissionBits(value){
  if(typeof value!=="string"||!/^[0-9]+$/.test(value))return null;
  try{return BigInt(value)}catch{return null}
}

function applyOverwrite(base,deny,allow){
  return (base&~deny)|allow;
}

function computeEffectivePermissions({guildId,member,roles,channel}){
  if(!member||!Array.isArray(member.roles)||member.roles.length>250||!Array.isArray(roles)||roles.length>250||
     !Array.isArray(channel.permission_overwrites)||channel.permission_overwrites.length>100)return null;
  if(!member.roles.every(id=>typeof id==="string"&&isDiscordSnowflake(id)))return null;

  const rolePermissions=new Map();
  for(const role of roles){
    if(!role||typeof role.id!=="string"||!isDiscordSnowflake(role.id))return null;
    const bits=decimalPermissionBits(role.permissions);
    if(bits===null||rolePermissions.has(role.id))return null;
    rolePermissions.set(role.id,bits);
  }
  const everyone=rolePermissions.get(guildId);
  if(everyone===undefined)return null;
  let base=everyone;
  for(const roleId of member.roles){
    const bits=rolePermissions.get(roleId);
    if(bits===undefined)return null;
    base|=bits;
  }

  // Administrator bypasses channel overwrites in Discord. Preserve the bit so
  // the least-privilege validator rejects it instead of treating it as read-only.
  const administrator=(base&USER_ADMINISTRATOR)!==0n;
  if(administrator)return base;

  const overwrites=channel.permission_overwrites;
  const parsed=[];
  const seenOverwrites=new Set();
  for(const overwrite of overwrites){
    if(!overwrite||typeof overwrite.id!=="string"||!isDiscordSnowflake(overwrite.id)||
       ![0,1].includes(overwrite.type))return null;
    const key=overwrite.type+":"+overwrite.id;
    if(seenOverwrites.has(key))return null;
    seenOverwrites.add(key);
    const allow=decimalPermissionBits(overwrite.allow);
    const deny=decimalPermissionBits(overwrite.deny);
    if(allow===null||deny===null)return null;
    parsed.push({id:overwrite.id,type:overwrite.type,allow,deny});
  }

  const everyoneOverwrite=parsed.find(item=>item.type===0&&item.id===guildId);
  if(everyoneOverwrite)
    base=applyOverwrite(base,everyoneOverwrite.deny,everyoneOverwrite.allow);

  let roleDeny=0n,roleAllow=0n;
  const memberRoleIds=new Set(member.roles);
  for(const overwrite of parsed){
    if(overwrite.type===0&&memberRoleIds.has(overwrite.id)){
      roleDeny|=overwrite.deny;
      roleAllow|=overwrite.allow;
    }
  }
  base=applyOverwrite(base,roleDeny,roleAllow);

  const memberOverwrite=parsed.find(item=>item.type===1&&item.id===member.user?.id);
  if(memberOverwrite)
    base=applyOverwrite(base,memberOverwrite.deny,memberOverwrite.allow);
  return base;
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
 * It fetches only explicitly authorized guild/channel IDs, then asks Discord
 * for the bot member's computed channel permissions. It never enumerates
 * unapproved channels or fetches message bodies.
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
       !/(?:Z|[+-]\d{2}:\d{2})$/i.test(permission.expiresAt)||
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
  if(activeCount===0){
    for(const group of groups){
      group.status="failed";
      group.errorCode=group.channels.find(channel=>channel.errorCode)?.errorCode??"no_active_authorized_channels";
    }
    return makeReport({checkedAt,groups,topLevelError:"no_active_authorized_channels"});
  }

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
  if(!bot||typeof bot.id!=="string"||!isDiscordSnowflake(bot.id)){
    for(const group of groups){
      for(const channel of group.channels)
        if(channel.status==="pending")Object.assign(channel,failedChannel(channel.channelId,"invalid_bot_identity_response"));
      group.status="failed";
      group.errorCode="invalid_bot_identity_response";
    }
    return makeReport({checkedAt,groups,topLevelError:"invalid_bot_identity_response"});
  }

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

    let guildResponse;
    try{
      guildResponse=await requestJson(
        "/guilds/"+group.guildId,
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
    if(!guildResponse||guildResponse.id!==group.guildId){
      for(const channel of pending)Object.assign(channel,failedChannel(channel.channelId,"invalid_guild_response"));
      group.status="failed";
      group.errorCode="invalid_guild_response";
      continue;
    }

    let roles,member;
    try{
      [roles,member]=await Promise.all([
        requestJson("/guilds/"+group.guildId+"/roles",
          {token,fetchImpl,baseUrl,timeoutMs,maxRetries,maxRetryDelayMs,sleep}),
        requestJson("/guilds/"+group.guildId+"/members/"+bot.id,
          {token,fetchImpl,baseUrl,timeoutMs,maxRetries,maxRetryDelayMs,sleep}),
      ]);
    }catch(error){
      const code=error instanceof DiscordApiError?error.code:"discord_api_unavailable";
      const mapped=code==="discord_forbidden"?"guild_access_denied":
        code==="discord_not_found"?"guild_member_or_roles_unavailable":code;
      for(const channel of pending)Object.assign(channel,failedChannel(channel.channelId,mapped));
      group.status="failed";
      group.errorCode=mapped;
      if(["invalid_bot_token","discord_api_unavailable","discord_rate_limited"].includes(code))
        stopAfterApiFailure=code;
      continue;
    }
    if(!Array.isArray(roles)||!member||member.user?.id!==bot.id||!Array.isArray(member.roles)){
      for(const channel of pending)Object.assign(channel,failedChannel(channel.channelId,"invalid_guild_permission_data"));
      group.status="failed";
      group.errorCode="invalid_guild_permission_data";
      continue;
    }

    for(const result of pending){
      if(stopAfterApiFailure){
        Object.assign(result,failedChannel(result.channelId,stopAfterApiFailure));
        continue;
      }
      let channel;
      try{
        channel=await requestJson(
          "/channels/"+result.channelId,
          {token,fetchImpl,baseUrl,timeoutMs,maxRetries,maxRetryDelayMs,sleep},
        );
      }catch(error){
        const code=error instanceof DiscordApiError?error.code:"discord_api_unavailable";
        const mapped=code==="discord_forbidden"?"channel_access_denied":
          code==="discord_not_found"?"channel_not_visible_or_missing":code;
        Object.assign(result,failedChannel(result.channelId,mapped));
        if(["invalid_bot_token","discord_api_unavailable","discord_rate_limited"].includes(code))
          stopAfterApiFailure=code;
        continue;
      }
      if(!channel||channel.id!==result.channelId||typeof channel.guild_id!=="string"){
        Object.assign(result,failedChannel(result.channelId,"invalid_channel_response"));
        continue;
      }
      if(channel.guild_id!==group.guildId){
        Object.assign(result,failedChannel(result.channelId,"channel_guild_mismatch"));
        continue;
      }
      if(!SUPPORTED_CHANNEL_TYPES.has(channel.type)){
        Object.assign(result,failedChannel(result.channelId,"unsupported_channel_type"));
        result.channelType=Number.isInteger(channel.type)?channel.type:null;
        continue;
      }
      const bits=computeEffectivePermissions({guildId:group.guildId,member,roles,channel});
      Object.assign(result,channelResult(result.channelId,channel.type,bits));
    }

    group.status=group.channels.every(channel=>channel.status==="passed")?"passed":"failed";
    group.errorCode=group.channels.find(channel=>channel.status!=="passed")?.errorCode??null;
  }

  return makeReport({checkedAt,botId:bot.id,groups,topLevelError:stopAfterApiFailure});
}
