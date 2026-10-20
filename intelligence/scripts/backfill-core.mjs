import {createHash,randomUUID} from "node:crypto";
import {readFile,writeFile,rename,unlink,open} from "node:fs/promises";
import {resolve} from "node:path";

const SAFE_SCOPE=/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/;
const SOURCES=new Set(["x","tg","blockchain"]);
const SHA256=/^[a-f0-9]{64}$/;
const NUMERIC_ID=/^[1-9][0-9]{0,24}$/;
const PEER=/^[1-9][0-9]{0,19}$/;

export function parseBackfillArgs(argv){
  const result={source:null,limit:20,execute:false,scope:null,checkpoint:null,help:false};
  const provided=new Set();
  for(let i=0;i<argv.length;i++){
    const token=argv[i];
    const split=token.indexOf("=");
    const flag=split<0?token:token.slice(0,split);
    const inline=split<0?undefined:token.slice(split+1);
    if(flag==="--help"||flag==="-h"){result.help=true;continue;}
    if(flag==="--execute"){if(inline!==undefined)throw new TypeError("invalid flag");result.execute=true;continue;}
    if(!["--source","--limit","--scope","--checkpoint"].includes(flag)||
        provided.has(flag))throw new TypeError("invalid/duplicate backfill option");
    provided.add(flag);
    const value=inline??argv[++i];
    if(typeof value!=="string"||!value)throw new TypeError("missing backfill option");
    if(flag==="--source"){
      if(!SOURCES.has(value))throw new TypeError("invalid source");
      result.source=value;
    }else if(flag==="--limit"){
      if(!/^[1-9][0-9]*$/.test(value)||Number(value)>100)throw new RangeError("limit 1..100");
      result.limit=Number(value);
    }else if(flag==="--scope"){
      if(!SAFE_SCOPE.test(value))throw new TypeError("invalid scope");
      result.scope=value;
    }else result.checkpoint=resolve(value);
  }
  if(!result.help&&!result.source)throw new TypeError("required --source x|tg|blockchain");
  if(result.execute&&(!result.scope||!result.checkpoint))throw new TypeError("execute requires --scope and --checkpoint");
  return result;
}
function iso(value){
  const parsed=value instanceof Date?value:new Date(value);
  if(!Number.isFinite(parsed.getTime()))throw new TypeError("invalid source observation time");
  return parsed.toISOString();
}
function ms(value){
  if(value===null||value===undefined)return null;
  const numeric=Number(value);
  if(!Number.isSafeInteger(numeric)||numeric<0||numeric>8_640_000_000_000_000)
    throw new TypeError("invalid source millisecond timestamp");
  return iso(numeric);
}
function reg(sourceSystem,eventKind,eventKey,schemaVersion,entityRefs,evidenceRef,kind,occurredAt,observedAt){
  return {
    sourceSystem,eventKind,eventKey,schemaVersion,
    payload:{
      registryEvent:{sourceSystem,eventKind,eventKey,schemaVersion,entityRefs,evidenceRef},
      timelineEvent:{
        schemaVersion:"timeline-v1",eventKey,kind,occurredAt,observedAt,
        entityRefs,evidenceRef,payload:{},
      },
    },
  };
}
/** A current snapshot observed at updated_at; NOT a reconstruction of the
 * tweet's first textual version. No task-context mint is ever promoted. */
export function buildXSnapshotEvent(row){
  if(!NUMERIC_ID.test(row.tweet_id)||!NUMERIC_ID.test(row.author_id??""))
    return null;
  const observedAt=ms(row.updated_at);
  if(observedAt===null)throw new TypeError("missing X snapshot observedAt");
  const occurredAt=ms(row.posted_at)??observedAt;
  const eventKey="x:backfill:tweet:"+row.tweet_id+":snapshot:"+row.updated_at;
  const refs=[{kind:"author",canonicalId:"x:"+row.author_id,
    firstSeenAt:observedAt,lastSeenAt:observedAt}];
  const evidence={sourceKind:"x_tweet",sourceId:"x:tweet:"+row.tweet_id,
    observedAt,occurredAt,parserVersion:"x-backfill-snapshot-v1"};
  return reg("x","tweet_observed",eventKey,"x-snapshot-v1",
    refs,evidence,"tweet_published",occurredAt,observedAt);
}
/** Current latest source snapshot, not recoverable first collection time.
 * Edited/deleted histories are NOT invented from the last row. */
export function buildTgSnapshotEvent(row){
  if(!PEER.test(row.peer_id??"")||!/^[1-9][0-9]{0,19}$/.test(String(row.message_id)))
    return null;
  if(row.deleted_at!==null&&row.deleted_at!==undefined)return null;
  const observedAt=iso(row.collected_at);
  const occurredAt=row.posted_at===null?observedAt:iso(row.posted_at);
  const hash=createHash("sha256").update(String(row.text??""),"utf8").digest("hex");
  const eventKey="tg:backfill:"+row.peer_id+":"+row.message_id+
    ":snapshot:"+Date.parse(observedAt)+":"+hash;
  const refs=[{kind:"source",canonicalId:"tg:source:"+row.peer_id,
    firstSeenAt:observedAt,lastSeenAt:observedAt}];
  const evidence={sourceKind:"tg_message",sourceId:"tg:message:"+row.peer_id+":"+row.message_id,
    observedAt,occurredAt,parserVersion:"tg-backfill-snapshot-v1"};
  return reg("tg","message_observed",eventKey,"tg-snapshot-v1",
    refs,evidence,"tg_message_published",occurredAt,observedAt);
}

export function initialCursor(source){
  return source==="x"?{len:0,id:""}:source==="tg"?{sourceId:"0",messageId:"0"}:{address:"",signature:""};
}
export function cursorOf(source,row){
  if(source==="x")return {len:row.tweet_id.length,id:row.tweet_id};
  if(source==="tg")return {sourceId:String(row.source_id),messageId:String(row.message_id)};
  return {address:row.address,signature:row.signature};
}
export function checkpointFor(source,scope,high,identity=null){
  if(identity!==null&&!SHA256.test(identity))throw new TypeError("invalid database identity");
  if(!SOURCES.has(source)||!SAFE_SCOPE.test(scope))throw new TypeError("invalid backfill checkpoint scope");
  return {version:1,source,scope,identity,high,cursor:initialCursor(source),
    visited:0,inserted:0,duplicates:0,excluded:0,complete:high===null};
}
export function validateCheckpoint(value,source,scope,identity=null){
  if(!value||typeof value!=="object"||Array.isArray(value)||
    value.version!==1||value.source!==source||value.scope!==scope||
    value.identity!==identity||
    value.high!==null&&typeof value.high!=="object"||
    !value.cursor||typeof value.cursor!=="object"||
    typeof value.complete!=="boolean"||
    ["visited","inserted","duplicates","excluded"].some(k=>!Number.isSafeInteger(value[k])||value[k]<0)||
    !SAFE_SCOPE.test(scope)){
    throw new TypeError("checkpoint scope/version mismatch or corrupted");
  }
  const keys=source==="x"?["len","id"]:source==="tg"?["sourceId","messageId"]:["address","signature"];
  for(const member of [value.cursor,value.high].filter(Boolean)){
    if(Object.keys(member).sort().join(",")!==[...keys].sort().join(","))
      throw new TypeError("checkpoint cursor shape mismatch");
  }
  // Defensive monotonic cursor validation: a copied or corrupted checkpoint
  // must not be able to skip unrelated history in a different source scope.
  const isX=v=>Number.isSafeInteger(v.len)&&v.len>=0&&
    (v.len===0?v.id==="":NUMERIC_ID.test(v.id)&&v.id.length===v.len);
  const isTg=v=>/^(0|[1-9][0-9]{0,19})$/.test(v.sourceId)&&
    /^(0|[1-9][0-9]{0,19})$/.test(v.messageId);
  const isChain=v=>typeof v.address==="string"&&typeof v.signature==="string"&&
    /^[1-9A-HJ-NP-Za-km-z]{0,128}$/.test(v.address)&&
    /^[1-9A-HJ-NP-Za-km-z]{0,128}$/.test(v.signature);
  const isValid=source==="x"?isX:source==="tg"?isTg:isChain;
  if(!isValid(value.cursor)||(value.high!==null&&!isValid(value.high))){
    throw new TypeError("invalid backfill cursor");
  }
  if(value.high!==null){
    const c=value.cursor,h=value.high;
    const cmp=source==="x"?(c.len-h.len||c.id.localeCompare(h.id)):
      source==="tg"?(BigInt(c.sourceId)-BigInt(h.sourceId)||
        BigInt(c.messageId)-BigInt(h.messageId)):
      (c.address.localeCompare(h.address)||c.signature.localeCompare(h.signature));
    if(cmp>0)throw new TypeError("checkpoint cursor exceeds high-water bound");
  }
  return value;
}
export async function readCheckpoint(path,source,scope,identity=null){
  try{return validateCheckpoint(JSON.parse(await readFile(path,"utf8")),source,scope,identity)}
  catch(error){if(error?.code==="ENOENT")return null;throw error;}
}
export async function writeCheckpoint(path,state){
  const target=resolve(path);
  const temp=target+"."+randomUUID()+".tmp";
  try{
    const handle=await open(temp,"wx",0o600);
    try{
      await handle.writeFile(JSON.stringify(state)+"\n","utf8");
      await handle.sync();
    }finally{await handle.close();}
    await rename(temp,target);
  }catch(error){
    try{await unlink(temp)}catch{ /* preserve original cause */ }
    throw error;
  }
}
export async function withExclusiveCheckpointLock(path,fn){
  const lock=resolve(path)+".lock";
  const handle=await open(lock,"wx",0o600);
  try{return await fn()}
  finally{await handle.close();await unlink(lock);}
}
export function advanceCheckpoint(state,rows,stats,source){
  const next={...state};
  if(rows.length){
    next.cursor=cursorOf(source,rows.at(-1));
    next.visited+=rows.length;
    next.inserted+=stats.inserted;
    next.duplicates+=stats.duplicates;
    next.excluded+=stats.excluded;
  }
  // A page shorter than the limit does NOT prove exhaustion: new/removed
  // source rows can appear concurrently. The caller must check another page.
  if(rows.length===0)next.complete=true;
  return next;
}
export function validateRawChainEvidence(row){
  if(!row||row.kind!=="wallet"||!SHA256.test(row.payload_hash??""))
    throw new TypeError("missing immutable blockchain raw wallet evidence hash");
  if(!Number.isSafeInteger(row.observed_at)||row.observed_at<0||
     !Number.isSafeInteger(row.block_time??0)||
     (row.block_time!==null&&row.block_time!==undefined&&
     (row.block_time<0||row.block_time>4_102_444_800))){
    throw new TypeError("invalid blockchain observation clocks");
  }
}
