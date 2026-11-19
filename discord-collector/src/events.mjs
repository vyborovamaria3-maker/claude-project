import {createHash} from "node:crypto";
import {isDiscordSnowflake} from "@claude-project/contracts";

const DAY_MS=86_400_000;
const MAX_AUTHORIZATION_DAYS=365;
const AUTHORIZATION_TIMESTAMP=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;

function authorizationExpiry(value,name,nowMs){
  if(typeof value!=="string"||!AUTHORIZATION_TIMESTAMP.test(value))
    throw new Error(name+" must be an offset-aware ISO timestamp");
  const [year,month,day,hour,minute,second]=value.slice(0,19).split(/[-T:]/).map(Number);
  const localDate=new Date(Date.UTC(year,month-1,day,hour,minute,second));
  if(year<2000||localDate.getUTCFullYear()!==year||localDate.getUTCMonth()!==month-1||
     localDate.getUTCDate()!==day||localDate.getUTCHours()!==hour||
     localDate.getUTCMinutes()!==minute||localDate.getUTCSeconds()!==second)
    throw new Error(name+" contains an invalid calendar date or time");
  const offset=/([+-])(\d{2}):(\d{2})$/.exec(value);
  if(offset&&(Number(offset[2])>14||Number(offset[3])>59||
     (Number(offset[2])===14&&Number(offset[3])!==0)))
    throw new Error(name+" contains an invalid UTC offset");
  const timestamp=Date.parse(value);
  if(!Number.isFinite(timestamp))throw new Error(name+" is not a valid ISO timestamp");
  if(timestamp>nowMs+MAX_AUTHORIZATION_DAYS*DAY_MS)
    throw new Error(name+" cannot extend more than 365 days without review");
  return new Date(timestamp).toISOString();
}

export function validateAuthorization(document,{allowErasureOnly=false,now=new Date()}={}) {
  if(!document||typeof document!=="object"||Array.isArray(document)||document.version!==2)
    throw new Error("Authorization document version 2 is mandatory");
  if(Object.keys(document).some(key=>!["version","mode","guilds"].includes(key)))
    throw new Error("Authorization document contains an unsupported field");
  if(!["collect","erasure_only"].includes(document.mode)||!Array.isArray(document.guilds)||
     document.guilds.length>1000)
    throw new Error("Authorization mode and bounded guild list are mandatory");
  const allowed=new Map();
  const expiredChannels=[];
  const expiredGuildIds=[];
  const nowMs=now instanceof Date?now.getTime():Date.parse(now);
  if(!Number.isFinite(nowMs))throw new TypeError("Authorization validation time is invalid");
  if(document.mode==="erasure_only"){
    if(!allowErasureOnly)throw new Error("Erasure-only mode requires DISCORD_ALLOW_ERASURE_ONLY=true");
    if(document.guilds.length!==0)throw new Error("Erasure-only mode must not contain authorized guilds");
    allowed.mode="erasure_only";
    allowed.erasureOnly=true;
    allowed.expiredChannels=expiredChannels;
    allowed.expiredGuildIds=expiredGuildIds;
    return allowed;
  }
  if(document.guilds.length===0)throw new Error("Collect mode requires an explicit nonempty guild list");

  const seenGuilds=new Set();
  const seenChannels=new Set();
  let totalChannels=0;
  for(const item of document.guilds){
    if(!item||typeof item!=="object"||Array.isArray(item)||
       Object.keys(item).some(key=>!["guild_id","channel_ids","community_permission_reference",
         "community_permission_expires_at","policy_review_reference","policy_review_expires_at",
         "reviewed_by","retention_days"].includes(key))||
       typeof item.guild_id!=="string"||!isDiscordSnowflake(item.guild_id)||
       !Array.isArray(item.channel_ids)||item.channel_ids.length===0||item.channel_ids.length>500)
      throw new Error("Guild id and bounded explicit channel_ids are required");
    const guildId=item.guild_id;
    if(seenGuilds.has(guildId))throw new Error("Duplicate authorized guild");
    seenGuilds.add(guildId);
    if(typeof item.policy_review_reference!=="string"||!item.policy_review_reference.trim()||
       item.policy_review_reference.length>1024||
       typeof item.community_permission_reference!=="string"||!item.community_permission_reference.trim()||
       item.community_permission_reference.length>1024||
       typeof item.reviewed_by!=="string"||!item.reviewed_by.trim()||item.reviewed_by.length>128)
      throw new Error("Bounded policy and community permission references and reviewer are mandatory");
    if(!Number.isInteger(item.retention_days)||item.retention_days<1||item.retention_days>365)
      throw new Error("Retention must be explicitly bounded to 1..365 days");
    const permissionExpiresAt=authorizationExpiry(
      item.community_permission_expires_at,"community_permission_expires_at",nowMs);
    const policyReviewExpiresAt=authorizationExpiry(
      item.policy_review_expires_at,"policy_review_expires_at",nowMs);
    const expiresAt=Math.min(Date.parse(permissionExpiresAt),Date.parse(policyReviewExpiresAt));
    const isExpired=expiresAt<=nowMs;
    for(const rawId of item.channel_ids){
      totalChannels++;
      if(totalChannels>10_000)throw new Error("Authorization document exceeds 10000 channels");
      if(typeof rawId!=="string"||!isDiscordSnowflake(rawId))throw new Error("Invalid channel snowflake");
      const channelId=rawId;
      if(seenChannels.has(channelId))throw new Error("Ambiguous duplicate channel");
      seenChannels.add(channelId);
      if(isExpired){
        expiredChannels.push(channelId);
      }else{
        allowed.set(channelId,{
          guildId,
          retentionDays:item.retention_days,
          policyReviewReference:item.policy_review_reference,
          permissionReference:item.community_permission_reference,
          permissionExpiresAt,
          policyReviewExpiresAt,
          expiresAt:new Date(expiresAt).toISOString(),
        });
      }
    }
    if(isExpired)expiredGuildIds.push(guildId);
  }
  allowed.mode="collect";
  allowed.erasureOnly=false;
  allowed.expiredChannels=expiredChannels;
  allowed.expiredGuildIds=expiredGuildIds;
  return allowed;
}
export function normalizeMessage(message, kind, observedAt=new Date().toISOString(), fallbackGuildId=null, deletionReason="deleted"){
  if(!["observed","edited","deleted"].includes(kind))throw new TypeError("Unsupported event kind");
  const id=String(message.id??"");
  const guildId=String(message.guildId??message.guild?.id??fallbackGuildId??"");
  const channelId=String(message.channelId??message.channel?.id??"");
  if(!isDiscordSnowflake(id)||!isDiscordSnowflake(guildId)||!isDiscordSnowflake(channelId))
    throw new TypeError("Message, guild and channel need valid snowflake ids");
  if(!Number.isFinite(Date.parse(observedAt)) || !/(Z|[+-]\d\d:\d\d)$/i.test(observedAt))
    throw new TypeError("observedAt must be an aware ISO timestamp");
  const authorId=message.author?.id ? String(message.author.id) : null;
  if(authorId&&!isDiscordSnowflake(authorId))throw new TypeError("Invalid author id");
  const content=kind==="deleted"?null:(typeof message.content==="string"?message.content:null);
  const contentSha=content===null?null:createHash("sha256").update(content).digest("hex");
  const editedAt=message.editedAt instanceof Date ? message.editedAt.toISOString() : null;
  const occurredAt=message.createdAt instanceof Date ? message.createdAt.toISOString() : null;
  // A partial edit without a Discord source edit timestamp cannot order revisions safely.
  if(kind==="edited" && !editedAt)throw new TypeError("Edited event needs a source editedAt timestamp");
  if(kind==="deleted" && !["deleted","retention_expired","channel_revoked"].includes(deletionReason))
    throw new TypeError("Invalid Discord deletion reason");
  if(kind!=="deleted" && deletionReason!=="deleted")
    throw new TypeError("Deletion reason is only valid for deleted messages");
  const revisionAt=editedAt??occurredAt;
  const revisionParts=[guildId,channelId,id,kind,editedAt??"",contentSha??""];
  if(kind==="deleted")revisionParts.push(deletionReason);
  const revisionKey=createHash("sha256").update(revisionParts.join("|")).digest("hex");
  return {messageId:id,guildId,channelId,authorId,kind,content,contentSha,
    occurredAt,editedAt,revisionAt,observedAt,revisionKey,
    ...(kind==="deleted"?{deletionReason}:{})};
}

export function allowedObservation(allowed, observation){
  const permission=allowed.get(observation.channelId);
  return Boolean(permission&&permission.guildId===observation.guildId);
}
