import { Api, type TelegramClient } from "telegram";
import {publicDiscoveryChannel} from "../validation.js";
import {discoverExternalPosts,type ExternalSettings}from "./external-discovery.js";
import {indexKnownMentions}from "./message-index.js";
import {publicPostRequest,matchesSearchTerm} from "./message-search.js";
import {persistMessage} from "../persistence/messages.js";
import {refreshGraphDays,utcDay} from "../analytics/rollups.js";
import type {RawTelegramMessage} from "../analytics/extract.js";
import { pool } from "../db.js";
import { refreshTwitterKeywords, type TweetKeywordSettings } from "./twitter-keywords.js";
import { classifyTelegramError } from "../queue/retry.js";

type Settings = TweetKeywordSettings & ExternalSettings & { message_search_enabled:boolean;message_terms:string[]; enabled: boolean; keywords: string[]; interval_minutes: number;
 results_per_query: number; queries_per_cycle: number; max_queries_per_day: number;
 max_new_per_day: number; max_sources: number; keyword_cursor: number; revision: number };


export async function addCandidate(candidate: NonNullable<ReturnType<typeof publicDiscoveryChannel>>, keyword: string, revision: number,msg?:RawTelegramMessage,fullCollection=false,external?:{provider:string;origin:string;url:string}): Promise<void> {
 const tx=await pool.connect();
 try {
  await tx.query("BEGIN");
  const settings=(await tx.query<Settings>("SELECT * FROM tg_discovery_settings WHERE id=1 FOR UPDATE")).rows[0];
  const runtime=(await tx.query<{active:boolean}>(`SELECT collection_enabled AND block_reason IS NULL AND
   (pause_until IS NULL OR pause_until<=now()) AS active FROM tg_runtime WHERE id=1 FOR SHARE`)).rows[0];
  if (!settings.enabled || (external&&(!settings.external_search_enabled||!settings.message_search_enabled)) || settings.revision!==revision || !runtime?.active) { await tx.query("ROLLBACK"); return; }
  await tx.query(`INSERT INTO tg_discovered_sources(peer_id,username,title,keyword) VALUES($1,$2,$3,$4)
   ON CONFLICT(peer_id) DO UPDATE SET username=EXCLUDED.username,title=EXCLUDED.title,
   keyword=EXCLUDED.keyword,last_seen_at=now()`,[candidate.peer,candidate.username,candidate.title,keyword]);
  const found=(await tx.query<{connected_at:Date|null}>("SELECT connected_at FROM tg_discovered_sources WHERE peer_id=$1",[candidate.peer])).rows[0];
  // A source previously removed or paused by the operator must not be resurrected.
  const existing=await tx.query("SELECT id FROM tg_sources WHERE peer_id=$1",[candidate.peer]);
  if (existing.rowCount) await tx.query(`UPDATE tg_discovered_sources SET source_id=$2,
   connected_at=COALESCE(connected_at,now()) WHERE peer_id=$1`,[candidate.peer,existing.rows[0].id]);
  const budget=(await tx.query<{added:number;total:number}>(`SELECT COALESCE((SELECT added FROM tg_discovery_daily
   WHERE day=(now() AT TIME ZONE 'UTC')::date),0)::int AS added,(SELECT count(*)::int FROM tg_sources) AS total`)).rows[0];
  if (!found.connected_at && !existing.rowCount && budget.added<settings.max_new_per_day && budget.total<settings.max_sources && (!msg || fullCollection || settings.max_new_per_day===1 || settings.max_new_per_day-budget.added>1)) {
   const source=await tx.query<{id:string}>(`INSERT INTO tg_sources(identifier,peer_id,title) VALUES($1,$2,$3)
    ON CONFLICT(identifier) DO NOTHING RETURNING id::text`,[candidate.username,candidate.peer,candidate.title]);
   if(source.rowCount) {
    await tx.query("INSERT INTO tg_jobs(source_id) VALUES($1) ON CONFLICT(source_id) DO NOTHING",[source.rows[0].id]);
    await tx.query("UPDATE tg_discovered_sources SET source_id=$2,connected_at=now() WHERE peer_id=$1",[candidate.peer,source.rows[0].id]);
    await tx.query(`INSERT INTO tg_discovery_daily(day,added) VALUES((now() AT TIME ZONE 'UTC')::date,1)
     ON CONFLICT(day) DO UPDATE SET added=tg_discovery_daily.added+1`);
   }
  }
  if(msg||fullCollection)await tx.query('UPDATE tg_sources SET full_history=TRUE WHERE peer_id=$1',[candidate.peer]);
  if(msg&&typeof msg.message==='string'){
   const linked=(await tx.query<{id:string;enabled:boolean}>('SELECT id::text,enabled FROM tg_sources WHERE peer_id=$1',[candidate.peer])).rows[0];
   await tx.query(`INSERT INTO tg_discovery_mentions(peer_id,message_id,username,title,text,posted_at,matched_terms,source_id)
    VALUES($1,$2,$3,$4,$5,$6,ARRAY[$7]::text[],$8) ON CONFLICT(peer_id,message_id) DO UPDATE SET
    text=EXCLUDED.text,last_seen_at=now(),source_id=EXCLUDED.source_id,
    matched_terms=(SELECT ARRAY(SELECT DISTINCT unnest(tg_discovery_mentions.matched_terms||EXCLUDED.matched_terms)))`,
    [candidate.peer,msg.id,candidate.username,candidate.title,msg.message.slice(0,8192),typeof msg.date==='number'?new Date(msg.date*1000):null,keyword,linked?.id??null]);
   if(linked?.enabled){await persistMessage(tx,linked.id,msg);if(typeof msg.date==='number'){const day=utcDay(new Date(msg.date*1000));if(day)await refreshGraphDays(tx,linked.id,[day]);};}
  }
  if(external&&msg)await tx.query(`INSERT INTO tg_external_verified_posts(peer_id,message_id,provider,origin,reference_url)
   SELECT $1,$2,$3,$4,$5 FROM tg_discovery_mentions WHERE peer_id=$1 AND message_id=$2
   ON CONFLICT(peer_id,message_id,provider)DO UPDATE SET verified_at=now()`,[candidate.peer,msg.id,external.provider,external.origin,external.url]);
  await tx.query("COMMIT");
 } catch(error) { await tx.query("ROLLBACK");throw error; } finally {tx.release();}
}

/** Run sequentially on the singleton worker; never creates sessions or joins chats. */
export async function discoverPublicSources(client: Pick<TelegramClient,"invoke">, stopping:()=>boolean): Promise<"continue"|"halt"> {
 const settings=(await pool.query<Settings>(`UPDATE tg_discovery_settings d SET
  next_run_at=now()+d.interval_minutes*interval '1 minute',last_run_at=now(),last_error_code=NULL
  WHERE d.id=1 AND d.enabled AND d.next_run_at<=now() AND EXISTS(SELECT 1 FROM tg_runtime
   WHERE id=1 AND collection_enabled AND block_reason IS NULL AND (pause_until IS NULL OR pause_until<=now()))
  RETURNING d.*`)).rows[0];
 if (!settings || stopping()) return "continue";
 let searched=false;let attemptedScope="full";
 try {
  if(settings.message_search_enabled){await indexKnownMentions();await discoverExternalPosts(client,settings,stopping); }
  const generated=await refreshTwitterKeywords(settings);
  settings.keywords=settings.message_search_enabled?[...new Set(settings.message_terms)]:[...new Set([...generated,...settings.keywords])];
  if(!settings.keywords.length)return "continue";
  for(let i=0;i<settings.queries_per_cycle && !stopping();i++) {
   // Reserve one request durably BEFORE contacting Telegram, including failed calls.
   const reserved=await pool.query<{queries:number}>(`INSERT INTO tg_discovery_daily(day,queries)
    SELECT (now() AT TIME ZONE 'UTC')::date,1 WHERE EXISTS(SELECT 1 FROM tg_discovery_settings d
     CROSS JOIN tg_runtime r WHERE d.id=1 AND r.id=1 AND d.enabled AND d.revision=$1
     AND r.collection_enabled AND r.block_reason IS NULL AND (r.pause_until IS NULL OR r.pause_until<=now())
     AND (d.message_search_enabled OR (SELECT count(*) FROM tg_sources)<d.max_sources))
    ON CONFLICT(day) DO UPDATE SET queries=tg_discovery_daily.queries+1
    WHERE tg_discovery_daily.queries<$2 AND ($4::boolean OR tg_discovery_daily.added<$3) RETURNING queries`,
    [settings.revision,settings.max_queries_per_day,settings.max_new_per_day,settings.message_search_enabled]);
   if(!reserved.rowCount) break;
   const keyword=settings.keywords[settings.keyword_cursor % settings.keywords.length];
   settings.keyword_cursor=(settings.keyword_cursor+1)%settings.keywords.length;
   await pool.query("UPDATE tg_discovery_settings SET keyword_cursor=$2 WHERE id=1 AND revision=$1",[settings.revision,settings.keyword_cursor]);
   if(settings.message_search_enabled){
    const access=(await pool.query("SELECT 1 FROM tg_message_search_cursors WHERE query='__fulltext_access' AND reset_at>now() AND last_error_code IS NOT NULL")).rowCount;
    const hashtagBlocked=(await pool.query("SELECT 1 FROM tg_message_search_cursors WHERE query='__hashtag_access' AND reset_at>now()")).rowCount;
    const hashtag=Boolean(access)&&!hashtagBlocked&&/^[a-zA-Z0-9_]{3,24}$/.test(keyword);
    attemptedScope=hashtag?'hashtag':access?'visible':'full';
    const scoped=Boolean(access)&&!hashtag;
    const cursorKey=(hashtag?'hashtag:':scoped?'visible:':'full:')+keyword;
    const cursor=(await pool.query<{offset_rate:number;offset_id:number;channel_id:string|null;access_hash:string|null}>(`SELECT offset_rate,offset_id,channel_id,access_hash FROM tg_message_search_cursors WHERE query=$1 AND reset_at>now()`,[cursorKey])).rows[0];
    const offset=cursor?{rate:cursor.offset_rate,id:cursor.offset_id,channel:cursor.channel_id,hash:cursor.access_hash}:undefined;
    const request=scoped?new Api.messages.SearchGlobal({broadcastsOnly:true,q:keyword,filter:new Api.InputMessagesFilterEmpty(),minDate:0,maxDate:0,
      offsetRate:cursor?.offset_rate??0,offsetId:cursor?.offset_id??0,offsetPeer:publicPostRequest(keyword,1,offset).offsetPeer,limit:settings.results_per_query}):publicPostRequest(keyword,settings.results_per_query,offset,hashtag);
    const result=await client.invoke(request);
    if(access)await pool.query("UPDATE tg_discovery_settings SET last_error_code='TG_SEARCH_PREMIUM_REQUIRED_LIMITED_MODE' WHERE id=1");
    if(!('messages' in result))continue;
    searched=true;
    for(const msg of result.messages){
     if(stopping())break;
     if(!(msg instanceof Api.Message)||!(msg.peerId instanceof Api.PeerChannel)||!matchesSearchTerm(msg.message,keyword))continue;
     const peerId=msg.peerId.channelId.toString();
     const chat=result.chats.find(c=>'id' in c&&c.id.toString()===peerId);
     const candidate=publicDiscoveryChannel(chat);if(candidate)await addCandidate(candidate,keyword,settings.revision,msg);
    }
    const last=result.messages.at(-1);
    const lastPeer=last instanceof Api.Message&&last.peerId instanceof Api.PeerChannel?last.peerId.channelId.toString():null;
    const chat=result.chats.find(c=>'id' in c&&c.id.toString()===lastPeer);
    const next=last instanceof Api.Message&&chat instanceof Api.Channel&&chat.accessHash?{id:last.id,rate:('nextRate' in result&&typeof result.nextRate==='number'?result.nextRate:last.date),channel:chat.id.toString(),hash:chat.accessHash.toString()}:null;
    await pool.query(`INSERT INTO tg_message_search_cursors(query,offset_rate,offset_id,channel_id,access_hash,reported_count,reset_at)
     SELECT $1,$2,$3,$4,$5,$6,now()+interval '6 hours' WHERE EXISTS(SELECT 1 FROM tg_discovery_settings WHERE id=1 AND revision=$7)
     ON CONFLICT(query) DO UPDATE SET offset_rate=EXCLUDED.offset_rate,offset_id=EXCLUDED.offset_id,channel_id=EXCLUDED.channel_id,access_hash=EXCLUDED.access_hash,
     reported_count=EXCLUDED.reported_count,last_error_code=NULL,updated_at=now(),reset_at=CASE WHEN EXCLUDED.offset_id=0 THEN now() ELSE tg_message_search_cursors.reset_at END`,
     [cursorKey,next?.rate??0,next?.id??0,next?.channel??null,next?.hash??null,'count' in result?result.count:null,settings.revision]);
   }else{
    const result=await client.invoke(new Api.contacts.Search({q:keyword,limit:settings.results_per_query}));
    searched=true;
    for(const chat of result.chats.slice(0,settings.results_per_query)) {
     if(stopping()) break;
     const candidate=publicDiscoveryChannel(chat);
     if(candidate) await addCandidate(candidate,keyword,settings.revision);
    }
   }
  }
  if(searched) await pool.query("UPDATE tg_discovery_settings SET last_completed_at=now() WHERE id=1");
 } catch(error) {
  const rawCode=String((error as {errorMessage?:string})?.errorMessage??'');
  if(/PREMIUM_ACCOUNT_REQUIRED|SEARCH_POSTS_TOO_MUCH|STARS_|PAYMENT_|METHOD_INVALID/.test(rawCode)){
   const code=rawCode.includes('METHOD_INVALID')?'TG_SEARCH_METHOD_UNAVAILABLE':rawCode.includes('PREMIUM_ACCOUNT_REQUIRED')?'TG_SEARCH_PREMIUM_REQUIRED':'TG_SEARCH_FREE_QUOTA_EXHAUSTED';
   await pool.query(`INSERT INTO tg_message_search_cursors(query,last_error_code,reset_at) VALUES($2,$1,now()+interval '6 hours')
    ON CONFLICT(query) DO UPDATE SET last_error_code=EXCLUDED.last_error_code,reset_at=EXCLUDED.reset_at`,[code,attemptedScope==='hashtag'?'__hashtag_access':'__fulltext_access']);
   await pool.query("UPDATE tg_discovery_settings SET last_error_code=$1,next_run_at=now()+interval '5 seconds' WHERE id=1",[code]);return 'continue';
  }
  const decision=classifyTelegramError(error,0);
  if(attemptedScope==='hashtag'&&decision.action==='delay'&&!decision.global){
   await pool.query(`INSERT INTO tg_message_search_cursors(query,last_error_code,reset_at)VALUES('__hashtag_access','TG_HASHTAG_SEARCH_UNAVAILABLE',now()+interval '6 hours')
    ON CONFLICT(query)DO UPDATE SET last_error_code=EXCLUDED.last_error_code,reset_at=EXCLUDED.reset_at`);
   await pool.query("UPDATE tg_discovery_settings SET last_error_code='TG_SEARCH_PREMIUM_REQUIRED_LIMITED_MODE',next_run_at=now()+interval '5 seconds' WHERE id=1");return 'continue';
  }
  await pool.query(`UPDATE tg_discovery_settings SET last_error_code=$1,
   next_run_at=GREATEST(next_run_at,now()+($2::int*interval '1 second')) WHERE id=1`,
   [decision.code,decision.action==='delay'?decision.seconds:3600]);
  if(decision.action==='halt') {
   await pool.query("UPDATE tg_runtime SET block_reason=$1,blocked_at=now(),last_error_code=$1 WHERE id=1",[decision.code]);
   return "halt";
  }
  if(decision.action==='delay' && decision.global) await pool.query(`UPDATE tg_runtime SET pause_until=GREATEST(
   COALESCE(pause_until,now()),now()+($1::int*interval '1 second')),last_error_code=$2 WHERE id=1`,[decision.seconds,decision.code]);
 }
 return "continue";
}
