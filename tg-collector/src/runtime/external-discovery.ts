import bigInt from 'big-integer';
import {Api,type TelegramClient}from 'telegram';
import {pool}from '../db.js';
import {publicDiscoveryChannel}from '../validation.js';
import {matchesSearchTerm}from './message-search.js';
import {publicReferences,previewMessageIds}from './public-links.js';
import {addCandidate}from './discovery.js';
import {readTwitterKeywordPosts}from './twitter-keywords.js';
import {classifyTelegramError}from '../queue/retry.js';
export type ExternalSettings={external_search_enabled:boolean;external_sources:string[];external_pages_per_cycle:number;
 external_max_pages_per_day:number;message_terms:string[];revision:number};
async function preview(url:string,fetcher:typeof fetch):Promise<string>{
 const r=await fetcher(url,{headers:{'user-agent':'Mozilla/5.0 (compatible; TGCollector/1.0)'},signal:AbortSignal.timeout(5000),redirect:'error'});
 if(!r.ok||!r.body)return '';
 const reader=r.body.getReader();let size=0;const chunks:Uint8Array[]=[];
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>524288)return '';chunks.push(part.value);}return Buffer.concat(chunks).toString('utf8');}
 finally{await reader.cancel();}
}
export async function discoverExternalPosts(client:Pick<TelegramClient,'invoke'>,s:ExternalSettings,stopping:()=>boolean,fetcher:typeof fetch=fetch){
 if(!s.external_search_enabled)return;
 const active=async()=>!stopping()&&Boolean((await pool.query(`SELECT 1 FROM tg_discovery_settings d CROSS JOIN tg_runtime r
  WHERE d.id=1 AND r.id=1 AND d.enabled AND d.external_search_enabled AND d.revision=$1 AND r.collection_enabled
  AND r.block_reason IS NULL AND (r.pause_until IS NULL OR r.pause_until<=now())`,[s.revision])).rowCount);
 if(!await active())return;
 const enqueue=async(username:string,origin:string,priority=0)=>{
  if(!/^[a-z][a-z0-9_]{4,31}$/i.test(username))return;
  await pool.query(`INSERT INTO tg_external_candidates(username,origin,priority) SELECT lower($1),$2,$3
   WHERE (SELECT count(*)FROM tg_external_candidates)<500 OR EXISTS(SELECT 1 FROM tg_external_candidates WHERE username=lower($1)) ON CONFLICT(username)DO UPDATE SET
    origin=CASE WHEN EXCLUDED.origin LIKE 'verified_post_link:%' THEN EXCLUDED.origin ELSE tg_external_candidates.origin END,
    last_checked_at=CASE WHEN EXCLUDED.origin LIKE 'verified_post_link:%' AND tg_external_candidates.origin NOT LIKE 'verified_post_link:%' THEN NULL ELSE tg_external_candidates.last_checked_at END`,[username,origin,priority]);
 };
 for(let i=0;i<s.external_sources.length;i++)await enqueue(s.external_sources[i],'configured_seed',100-i);
 // Public links in actual PNUT posts are candidates only, never counted as verified mentions.
 const posts=(await pool.query<{text:string;username:string;message_id:string}>('SELECT text,username,message_id::text FROM tg_discovery_mentions ORDER BY last_seen_at DESC LIMIT 100')).rows;
 for(const post of posts)for(const ref of publicReferences(post.text,10))await enqueue(ref.username,'verified_post_link:https://t.me/'+post.username+'/'+post.message_id);
 const twitterUrl=process.env.TG_DISCOVERY_TWITTER_DATABASE_URL;
 if(twitterUrl){try{for(const post of await readTwitterKeywordPosts(twitterUrl,72,500))if(s.message_terms.some(t=>matchesSearchTerm(post.text,t)))
  for(const ref of publicReferences(post.text,10))await enqueue(ref.username,'twitter_post_link');}catch{/* Twitter outage does not stop public preview discovery. */}}
 const deadline=Date.now()+25000;
 for(let page=0;page<s.external_pages_per_cycle&&Date.now()<deadline&&await active();page++){
  const budget=await pool.query(`INSERT INTO tg_external_daily(day,pages,rpc_reserved)VALUES((now()AT TIME ZONE 'UTC')::date,1,2)
   ON CONFLICT(day)DO UPDATE SET pages=tg_external_daily.pages+1,rpc_reserved=tg_external_daily.rpc_reserved+2
   WHERE tg_external_daily.pages<$1 RETURNING pages`,[s.external_max_pages_per_day]);
  if(!budget.rowCount)break;
  const candidate=(await pool.query<{username:string;origin:string;term_cursor:number}>(`SELECT username,origin,term_cursor FROM tg_external_candidates
   ORDER BY last_checked_at ASC NULLS FIRST,priority DESC,username LIMIT 1`)).rows[0];
  if(!candidate)break;
  const term=s.message_terms[candidate.term_cursor%s.message_terms.length];
  await pool.query("UPDATE tg_external_candidates SET last_checked_at=now(),term_cursor=term_cursor+1,status='checking'WHERE username=$1",[candidate.username]);
  const offset=(await pool.query<{before_id:number}>('SELECT before_id FROM tg_external_search_cursors WHERE username=$1 AND query=$2',[candidate.username,term])).rows[0]?.before_id??0;
  const url='https://t.me/s/'+candidate.username+'?q='+encodeURIComponent(term)+(offset?'&before='+offset:'');
  let html='';try{html=await preview(url,fetcher);}catch{/* Public groups may have no web preview; verify with allowed per-channel search. */}
  const ids=previewMessageIds(html,candidate.username);
  if(!await active())break;
  try{
   const resolved=await client.invoke(new Api.contacts.ResolveUsername({username:candidate.username}));
   const chat=resolved.chats.find(c=>publicDiscoveryChannel(c)?.username===candidate.username);
   const publicChat=publicDiscoveryChannel(chat);
   if(!publicChat||!(chat instanceof Api.Channel)||!chat.accessHash){await pool.query("UPDATE tg_external_candidates SET status='not_public_channel'WHERE username=$1",[candidate.username]);continue;}
   if(!await active())break;
   const peer=new Api.InputChannel({channelId:chat.id,accessHash:chat.accessHash});
   const relatedGroup=Boolean(chat.megagroup)&&candidate.origin.startsWith('verified_post_link:https://t.me/');
   const result=relatedGroup?await client.invoke(new Api.messages.GetHistory({peer:new Api.InputPeerChannel({channelId:chat.id,accessHash:chat.accessHash}),offsetId:0,offsetDate:0,addOffset:0,limit:20,maxId:0,minId:0,hash:bigInt(0)})):ids.length?await client.invoke(new Api.channels.GetMessages({channel:peer,id:ids.map(id=>new Api.InputMessageID({id}))})):
    await client.invoke(new Api.messages.Search({peer:new Api.InputPeerChannel({channelId:chat.id,accessHash:chat.accessHash}),q:term,filter:new Api.InputMessagesFilterEmpty(),minDate:0,maxDate:0,offsetId:offset,addOffset:0,limit:20,maxId:0,minId:0,hash:bigInt(0)}));
   if(!('messages'in result))continue;
   let relatedConnected=false;
   if(relatedGroup&&result.messages.some(m=>m instanceof Api.Message&&m.peerId instanceof Api.PeerChannel&&m.peerId.channelId.toString()===chat.id.toString())&&await active()){
    await addCandidate(publicChat,'public group linked from '+term,s.revision,undefined,true);
    relatedConnected=Boolean((await pool.query('SELECT 1 FROM tg_sources WHERE peer_id=$1',[publicChat.peer])).rowCount);
   }
   let verified=0;
   for(const msg of result.messages){
    if(!await active())break;
    if(!(msg instanceof Api.Message)||!(msg.peerId instanceof Api.PeerChannel)||msg.peerId.channelId.toString()!==chat.id.toString()||!matchesSearchTerm(msg.message,term))continue;
    await addCandidate(publicChat,term,s.revision,msg,Boolean(chat.megagroup),{provider:ids.length?'public_preview':'linked_channel_search',origin:candidate.origin,url:'https://t.me/'+candidate.username+'/'+msg.id});verified++;
    for(const ref of publicReferences(msg.message,10))await enqueue(ref.username,'verified_post_link:https://t.me/'+candidate.username+'/'+msg.id);
   }
   if(await active()){
    const lowest=ids.length?Math.min(...ids):Math.min(...result.messages.map(m=>m.id));
    await pool.query(`INSERT INTO tg_external_search_cursors(username,query,before_id)VALUES($1,$2,$3)
     ON CONFLICT(username,query)DO UPDATE SET before_id=EXCLUDED.before_id,updated_at=now()`,[candidate.username,term,Number.isFinite(lowest)&&lowest>0?lowest:0]);
    await pool.query('UPDATE tg_external_candidates SET status=$2 WHERE username=$1',[candidate.username,verified?'verified':relatedConnected?'related_public_group_connected':'no_matching_posts']);
    await pool.query('UPDATE tg_discovery_settings SET external_last_run_at=now(),external_error_code=NULL WHERE id=1 AND revision=$1',[s.revision]);
   }
  }catch(error){
   const decision=classifyTelegramError(error,0);if(decision.action==='halt'||(decision.action==='delay'&&decision.global))throw error;
   await pool.query("UPDATE tg_external_candidates SET status='unavailable'WHERE username=$1",[candidate.username]);
   await pool.query("UPDATE tg_discovery_settings SET external_error_code='EXTERNAL_SOURCE_UNAVAILABLE'WHERE id=1 AND revision=$1",[s.revision]);
  }
 }
}
