import {createHash} from "node:crypto";
const SNOWFLAKE=/^[0-9]{15,22}$/;

export function validateAuthorization(document) {
  if(!document || typeof document!=="object" || !Array.isArray(document.guilds) || document.guilds.length===0)
    throw new Error("Nonempty, explicit authorized guild list is mandatory");
  const allowed=new Map();
  for(const item of document.guilds){
    if(!SNOWFLAKE.test(String(item.guild_id)) || !Array.isArray(item.channel_ids))
      throw new Error("Guild id and explicit channel_ids are required");
    if(!item.policy_review_reference || !item.community_permission_reference || !item.reviewed_by)
      throw new Error("Policy and community permissions must be recorded");
    if(!Number.isInteger(item.retention_days) || item.retention_days<1 || item.retention_days>365)
      throw new Error("Retention must be explicitly bounded to 1..365 days");
    if(item.channel_ids.length===0)throw new Error("Every authorized guild needs channels");
    for(const id of item.channel_ids){
      if(!SNOWFLAKE.test(String(id))) throw new Error("Invalid channel snowflake");
      if(allowed.has(String(id))) throw new Error("Ambiguous duplicate channel");
      allowed.set(String(id),{guildId:String(item.guild_id),retentionDays:item.retention_days,
        policyReviewReference:item.policy_review_reference,
        permissionReference:item.community_permission_reference});
    }
  }
  return allowed;
}

export function normalizeMessage(message, kind, observedAt=new Date().toISOString(), fallbackGuildId=null){
  if(!["observed","edited","deleted"].includes(kind))throw new TypeError("Unsupported event kind");
  const id=String(message.id??"");
  const guildId=String(message.guildId??message.guild?.id??fallbackGuildId??"");
  const channelId=String(message.channelId??message.channel?.id??"");
  if(!SNOWFLAKE.test(id)||!SNOWFLAKE.test(guildId)||!SNOWFLAKE.test(channelId))
    throw new TypeError("Message, guild and channel need valid snowflake ids");
  if(!Number.isFinite(Date.parse(observedAt)) || !/(Z|[+-]\d\d:\d\d)$/i.test(observedAt))
    throw new TypeError("observedAt must be an aware ISO timestamp");
  const authorId=message.author?.id ? String(message.author.id) : null;
  if(authorId&&!SNOWFLAKE.test(authorId))throw new TypeError("Invalid author id");
  const content=kind==="deleted"?null:(typeof message.content==="string"?message.content:null);
  const contentSha=content===null?null:createHash("sha256").update(content).digest("hex");
  const editedAt=message.editedAt instanceof Date ? message.editedAt.toISOString() : null;
  const occurredAt=message.createdAt instanceof Date ? message.createdAt.toISOString() : null;
  // A partial edit without a Discord source edit timestamp cannot order revisions safely.
  if(kind==="edited" && !editedAt)throw new TypeError("Edited event needs a source editedAt timestamp");
  const revisionAt=editedAt??occurredAt;
  const revisionKey=createHash("sha256")
    .update([guildId,channelId,id,kind,editedAt??"",contentSha??""].join("|")).digest("hex");
  return {messageId:id,guildId,channelId,authorId,kind,content,contentSha,
    occurredAt,editedAt,revisionAt,observedAt,revisionKey};
}

export function allowedObservation(allowed, observation){
  const permission=allowed.get(observation.channelId);
  return Boolean(permission&&permission.guildId===observation.guildId);
}
