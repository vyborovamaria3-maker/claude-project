import {test} from 'node:test';import assert from 'node:assert/strict';
import {Api,type TelegramClient} from 'telegram';import bigInt from 'big-integer';import {randomUUID}from 'node:crypto';
import {publicPostRequest,matchesSearchTerm}from '../src/runtime/message-search.js';
const mint='2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump';
test('full-text request never authorizes Stars and exact term matching preserves mint case',()=>{
 const bytes=publicPostRequest('PNUT',50).getBytes();assert.equal(bytes.readUInt32LE(0),0xf2c4f24d);assert.equal(bytes.readInt32LE(4),2);
 for(const text of ['$PNUT rally','#pnut','Peanut  the Squirrel'])assert.equal(matchesSearchTerm(text,text.includes('Peanut')?'Peanut the Squirrel':'PNUT'),true);
 assert.equal(matchesSearchTerm('pnutya','PNUT'),false);assert.equal(matchesSearchTerm(mint.toLowerCase(),mint),false);assert.equal(matchesSearchTerm(mint+'abc',mint),false);assert.equal(matchesSearchTerm('ca: '+mint,mint),true);
});
test('public post dedup, canonical reactions, discussion queue, Stop and full history beyond initial cutoff',{skip:!process.env.DATABASE_URL},async()=>{
 const {pool,migrate}=await import('../src/db.js');await migrate();
 const {discoverPublicSources}=await import('../src/runtime/discovery.js');const {discoverDiscussion}=await import('../src/runtime/discussion.js');const {processJob}=await import('../src/engines/channel.js');
 const prefix='post_'+randomUUID().replaceAll('-','').slice(0,10);const peer=String(Date.now()*1000);const groupPeer=String(Number(peer)+1);const historyPeer=String(Number(peer)+2);
 const chat=new Api.Channel({id:bigInt(peer),accessHash:bigInt(123),username:prefix,title:'Public news',broadcast:true});
 const group=new Api.Channel({id:bigInt(groupPeer),accessHash:bigInt(124),username:prefix+'_chat',title:'Public discussion',megagroup:true});
 const msg=new Api.Message({id:10,peerId:new Api.PeerChannel({channelId:chat.id}),message:'$PNUT '+mint,date:1700000000,views:123,reactions:new Api.MessageReactions({results:[new Api.ReactionCount({reaction:new Api.ReactionEmoji({emoticon:'🔥'}),count:5})]})});
 const ready=()=>pool.query('UPDATE tg_discovery_settings SET next_run_at=now() WHERE id=1');
 try{
  await pool.query('UPDATE tg_runtime SET collection_enabled=TRUE,block_reason=NULL,pause_until=NULL WHERE id=1');
  await pool.query('UPDATE tg_discovery_settings SET enabled=TRUE,message_search_enabled=TRUE,message_terms=$1,auto_keywords_enabled=FALSE,pump_enabled=FALSE,queries_per_cycle=2,max_new_per_day=1,max_queries_per_day=24,max_sources=1000,next_run_at=now(),keyword_cursor=0 WHERE id=1',[["PNUT",mint]]);
  await pool.query("DELETE FROM tg_discovery_daily WHERE day=(now() AT TIME ZONE 'UTC')::date");
  let calls=0;const client={invoke:async()=>{calls++;return new Api.messages.MessagesSlice({count:1000,nextRate:1,messages:[msg],chats:[chat],users:[]});}}as unknown as Pick<TelegramClient,'invoke'>;
  await discoverPublicSources(client,()=>false);assert.equal(calls,2,'source cap does not stop message discovery');
  const mentions=(await pool.query('SELECT * FROM tg_discovery_mentions WHERE peer_id=$1',[peer])).rows;assert.equal(mentions.length,1);assert.equal(mentions[0].matched_terms.length,2);
  const source=(await pool.query('SELECT * FROM tg_sources WHERE peer_id=$1',[peer])).rows[0];assert.equal(source.full_history,true);
  const saved=(await pool.query('SELECT views,reactions FROM tg_messages WHERE source_id=$1 AND message_id=10',[source.id])).rows[0];assert.equal(saved.views,123);assert.equal(saved.reactions[0].count,5);
  await pool.query('UPDATE tg_discovery_settings SET max_new_per_day=2 WHERE id=1');
  await discoverDiscussion({invoke:async()=>({fullChat:new Api.ChannelFull({id:chat.id,linkedChatId:group.id}),chats:[group]})}as unknown as TelegramClient,String(source.id),chat);
  const linked=(await pool.query('SELECT discussion_source_id,status FROM tg_source_discussions WHERE channel_source_id=$1',[source.id])).rows[0];assert.equal(linked.status,'connected');
  assert.equal((await pool.query('SELECT full_history FROM tg_sources WHERE id=$1',[linked.discussion_source_id])).rows[0].full_history,true);
  await pool.query('DELETE FROM tg_discovery_mentions WHERE peer_id=$1',[peer]);await ready();
  await discoverPublicSources({invoke:async()=>{await pool.query('UPDATE tg_runtime SET collection_enabled=FALSE WHERE id=1');return new Api.messages.MessagesSlice({count:1000,messages:[new Api.Message({id:11,peerId:msg.peerId,date:msg.date,message:msg.message})],chats:[chat],users:[]});}}as unknown as Pick<TelegramClient,'invoke'>,()=>false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tg_discovery_mentions WHERE peer_id=$1 AND message_id=11',[peer])).rows[0].n,0);
  await pool.query('UPDATE tg_runtime SET collection_enabled=TRUE WHERE id=1');
  const hist=(await pool.query('INSERT INTO tg_sources(identifier,peer_id,full_history) VALUES($1,$2,TRUE) RETURNING id',[prefix+'_hist',historyPeer])).rows[0];
  const job=(await pool.query('INSERT INTO tg_jobs(source_id)VALUES($1)RETURNING *',[hist.id])).rows[0];
  const all=Array.from({length:600},(_,i)=>({id:600-i,message:'ordinary public history',date:1700000000,views:i,reactions:{results:[]}}));
  const historyClient={getEntity:async()=>new Api.Channel({id:bigInt(historyPeer),title:'History',megagroup:true,username:prefix+'_hist'}),getMessages:async(_e:unknown,o:{limit:number;offsetId?:number})=>o.offsetId?all.filter(m=>m.id<o.offsetId!).slice(0,o.limit):all.slice(0,o.limit)}as unknown as TelegramClient;
  for(let turn=0;turn<6;turn++){
   const current=(await pool.query('SELECT * FROM tg_jobs WHERE id=$1',[job.id])).rows[0];await processJob(historyClient,current,()=>false);
   if((await pool.query('SELECT history_complete FROM tg_sources WHERE id=$1',[hist.id])).rows[0].history_complete)break;
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tg_messages WHERE source_id=$1',[hist.id])).rows[0].n,600);
  const done=(await pool.query('SELECT history_complete,history_partial FROM tg_sources WHERE id=$1',[hist.id])).rows[0];assert.equal(done.history_complete,true);assert.equal(done.history_partial,false);
  await pool.query('UPDATE tg_discovery_settings SET queries_per_cycle=1,keyword_cursor=0 WHERE id=1');await ready();
  await discoverPublicSources({invoke:async()=>{throw Object.assign(new Error('premium required'),{errorMessage:'PREMIUM_ACCOUNT_REQUIRED'});}}as unknown as Pick<TelegramClient,'invoke'>,()=>false);
  assert.equal((await pool.query('SELECT last_error_code FROM tg_discovery_settings WHERE id=1')).rows[0].last_error_code,'TG_SEARCH_PREMIUM_REQUIRED');
  await pool.query('UPDATE tg_discovery_settings SET keyword_cursor=0 WHERE id=1');await ready();
  await discoverPublicSources({invoke:async(request:{getBytes():Buffer})=>{assert.equal(request.getBytes().readInt32LE(4),1,'free hashtag mode never authorizes Stars');return new Api.messages.MessagesSlice({count:1000,messages:[msg],chats:[chat],users:[]});}}as unknown as Pick<TelegramClient,'invoke'>,()=>false);
  assert.equal((await pool.query('SELECT block_reason FROM tg_runtime WHERE id=1')).rows[0].block_reason,null);
  await pool.query('UPDATE tg_discovery_settings SET keyword_cursor=0 WHERE id=1');await ready();
  await discoverPublicSources({invoke:async()=>{throw new Error('unsupported hashtag response');}}as unknown as Pick<TelegramClient,'invoke'>,()=>false);
  await pool.query('UPDATE tg_discovery_settings SET keyword_cursor=0 WHERE id=1');await ready();
  await discoverPublicSources({invoke:async(request:Api.messages.SearchGlobal)=>{assert.equal(request.className,'messages.SearchGlobal');assert.equal(request.broadcastsOnly,true);return new Api.messages.MessagesSlice({count:1000,messages:[msg],chats:[chat],users:[]});}}as unknown as Pick<TelegramClient,'invoke'>,()=>false);
  assert.equal((await pool.query('SELECT last_error_code FROM tg_discovery_settings WHERE id=1')).rows[0].last_error_code,'TG_SEARCH_PREMIUM_REQUIRED_LIMITED_MODE');

 }finally{
  await pool.query('DELETE FROM tg_discovery_mentions WHERE peer_id=$1',[peer]);await pool.query('DELETE FROM tg_sources WHERE identifier LIKE $1',[prefix+'%']);await pool.query('DELETE FROM tg_discovered_sources WHERE username LIKE $1',[prefix+'%']);
  await pool.query('DELETE FROM tg_message_search_cursors WHERE query=ANY($1::text[])',[["PNUT",mint,"full:PNUT","full:"+mint,"hashtag:PNUT","__fulltext_access","__hashtag_access","visible:PNUT"]]);await pool.query('UPDATE tg_discovery_settings SET enabled=FALSE,message_search_enabled=FALSE WHERE id=1');await pool.query('UPDATE tg_runtime SET collection_enabled=TRUE WHERE id=1');await pool.end();
 }
});
