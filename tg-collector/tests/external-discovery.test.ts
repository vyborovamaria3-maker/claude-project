import {test}from 'node:test';import assert from 'node:assert/strict';import {randomUUID}from 'node:crypto';
import {Api,type TelegramClient}from 'telegram';import bigInt from 'big-integer';
import {publicReferences,previewMessageIds}from '../src/runtime/public-links.js';
test('public links and preview IDs reject private/invite/bot/wrong-source/overflow targets',()=>{
 assert.deepEqual(publicReferences('https://t.me/s/real_news/42 t.me/real_news/42 https://telegram.me/public_chat https://t.me/+private https://evil.t.me/not_real/1 t.me/c/123 t.me/login t.me/help_bot'),[{username:'real_news',messageId:42},{username:'public_chat',messageId:null}]);
 assert.deepEqual(previewMessageIds('<div data-post="real_news/42"></div><div data-post="other_chat/99"></div><div data-post="real_news/42"></div><div data-post="real_news/99999999999999"></div>','real_news'),[42]);
 assert.equal(publicReferences('t.me/real_news/1 t.me/other_news/2',1).length,1);
});
test('external evidence requires real public Telegram posts; budgets and Stop fence ingestion',{skip:!process.env.DATABASE_URL},async()=>{
 const {pool,migrate}=await import('../src/db.js');await migrate();const {discoverExternalPosts}=await import('../src/runtime/external-discovery.js');
 const prefix='ext_'+randomUUID().replaceAll('-','').slice(0,10);const group=prefix+'_group',news=prefix+'_news';const peer=bigInt(String(Date.now()*1000));
 const settings={external_search_enabled:true,external_sources:[group],external_pages_per_cycle:1,external_max_pages_per_day:1,message_terms:['PNUT'],revision:1};
 let calls=0;let text='$PNUT verified public message';let stopOnResolve=false;
 const client={invoke:async(request:{className:string;username?:string;getBytes():Buffer})=>{
  calls++;request.getBytes();const username=request.username??settings.external_sources[0];
  const chat=new Api.Channel({id:peer,accessHash:bigInt(123),username,title:'Public source',megagroup:username===group,broadcast:username!==group});
  if(request.className==='contacts.ResolveUsername'){
   if(stopOnResolve)await pool.query('UPDATE tg_runtime SET collection_enabled=FALSE WHERE id=1');return {chats:[chat],users:[]};
  }
  assert.ok(['messages.Search','channels.GetMessages','messages.GetHistory'].includes(request.className));
  return new Api.messages.Messages({messages:[new Api.Message({id:42,peerId:new Api.PeerChannel({channelId:peer}),message:text,date:1700000000,views:123})],chats:[chat],users:[]});
 }}as unknown as Pick<TelegramClient,'invoke'>;
 try{
  await pool.query('UPDATE tg_runtime SET collection_enabled=TRUE,block_reason=NULL,pause_until=NULL WHERE id=1');
  const config=(await pool.query('UPDATE tg_discovery_settings SET enabled=TRUE,message_search_enabled=TRUE,external_search_enabled=TRUE,max_new_per_day=1,max_sources=1000,revision=revision+1 RETURNING revision')).rows[0];settings.revision=config.revision;
  await pool.query("DELETE FROM tg_external_daily WHERE day=(now()AT TIME ZONE 'UTC')::date");await pool.query("DELETE FROM tg_discovery_daily WHERE day=(now()AT TIME ZONE 'UTC')::date");
  await discoverExternalPosts(client,settings,()=>false,async()=>new Response('public group without a web preview'));
  assert.equal(calls,2);assert.equal((await pool.query('SELECT count(*)::int AS n FROM tg_external_verified_posts WHERE peer_id=$1',[peer.toString()])).rows[0].n,1);
  const source=(await pool.query('SELECT full_history FROM tg_sources WHERE identifier=$1',[group])).rows[0];assert.equal(source.full_history,true);
  await discoverExternalPosts(client,settings,()=>false,async()=>new Response(''));assert.equal(calls,2,'durable daily page cap prevents further RPCs');
  await pool.query("DELETE FROM tg_external_daily WHERE day=(now()AT TIME ZONE 'UTC')::date");
  await pool.query('DELETE FROM tg_external_candidates WHERE username LIKE $1',[prefix+'%']);settings.external_sources=[news];text='unrelated text without the requested asset';
  await discoverExternalPosts(client,settings,()=>false,async()=>new Response('<div data-post="'+news+'/42">PNUT misleading snippet</div>'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tg_external_verified_posts WHERE peer_id=$1',[peer.toString()])).rows[0].n,1,'HTML snippets are never evidence');
  await pool.query("DELETE FROM tg_external_daily WHERE day=(now()AT TIME ZONE 'UTC')::date");
  await pool.query('DELETE FROM tg_external_candidates WHERE username LIKE $1',[prefix+'%']);settings.external_sources=[group];
  await pool.query('INSERT INTO tg_external_candidates(username,origin)VALUES($1,$2)',[group,'verified_post_link:https://t.me/public_news/99']);
  await discoverExternalPosts(client,settings,()=>false,async()=>new Response(''));
  assert.equal((await pool.query('SELECT status FROM tg_external_candidates WHERE username=$1',[group])).rows[0].status,'related_public_group_connected');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tg_external_verified_posts WHERE peer_id=$1',[peer.toString()])).rows[0].n,1,'unrelated group history is not a PNUT mention');
  await pool.query("DELETE FROM tg_external_daily WHERE day=(now()AT TIME ZONE 'UTC')::date");stopOnResolve=true;const before=calls;
  await discoverExternalPosts(client,settings,()=>false,async()=>new Response(''));
  assert.equal(calls,before+1,'Stop after resolution prevents the post-fetch RPC');
 }finally{
  await pool.query('DELETE FROM tg_discovery_mentions WHERE peer_id=$1',[peer.toString()]);await pool.query('DELETE FROM tg_sources WHERE identifier LIKE $1',[prefix+'%']);await pool.query('DELETE FROM tg_discovered_sources WHERE username LIKE $1',[prefix+'%']);
  await pool.query('DELETE FROM tg_external_search_cursors WHERE username LIKE $1',[prefix+'%']);await pool.query('DELETE FROM tg_external_candidates WHERE username LIKE $1',[prefix+'%']);
  await pool.query('UPDATE tg_discovery_settings SET enabled=FALSE,external_search_enabled=FALSE,message_search_enabled=FALSE WHERE id=1');await pool.query('UPDATE tg_runtime SET collection_enabled=TRUE WHERE id=1');await pool.end();
 }
});
