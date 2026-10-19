import {Api,type TelegramClient} from 'telegram';
import {classifyTelegramError}from '../queue/retry.js';
import {pool} from '../db.js';
import {publicDiscoveryChannel} from '../validation.js';
import {addCandidate} from './discovery.js';
/** Read linked public discussion metadata only. Never joins private groups. */
export async function discoverDiscussion(client:TelegramClient,sourceId:string,entity:Api.Channel){
 const checked=await pool.query("SELECT 1 FROM tg_source_discussions WHERE channel_source_id=$1 AND checked_at>now()-interval '1 day'",[sourceId]);
 if(checked.rowCount||!entity.broadcast)return;
 let full;
 try{full=await client.invoke(new Api.channels.GetFullChannel({channel:entity}));}
 catch(error){const decision=classifyTelegramError(error,0);if(decision.action==='halt'||(decision.action==='delay'&&decision.global))throw error;
  await pool.query(`INSERT INTO tg_source_discussions(channel_source_id,status)VALUES($1,'lookup_unavailable')
   ON CONFLICT(channel_source_id)DO UPDATE SET status=EXCLUDED.status,checked_at=now()`,[sourceId]);return;
 }
 const linked=full.fullChat instanceof Api.ChannelFull?full.fullChat.linkedChatId:undefined;
 let status='no_discussion',source:string|null=null;
 if(linked){
  let chat=full.chats.find(c=>'id' in c&&c.id.toString()===linked.toString());
  if(chat instanceof Api.Channel&&chat.accessHash&&!publicDiscoveryChannel(chat)){
   try{const resolved=await client.invoke(new Api.channels.GetChannels({id:[new Api.InputChannel({channelId:chat.id,accessHash:chat.accessHash})]}));chat=resolved.chats.find(c=>'id'in c&&c.id.toString()===linked.toString());}
   catch(error){const decision=classifyTelegramError(error,0);if(decision.action==='halt'||(decision.action==='delay'&&decision.global))throw error;}
  }
  const candidate=publicDiscoveryChannel(chat);
  status='private_or_unavailable';
  if(candidate){
   const config=(await pool.query<{revision:number}>('SELECT revision FROM tg_discovery_settings WHERE id=1')).rows[0];
   await addCandidate(candidate,'discussion:'+entity.id.toString(),config.revision,undefined,true);
   source=(await pool.query<{id:string}>('SELECT id::text FROM tg_sources WHERE peer_id=$1',[candidate.peer])).rows[0]?.id??null;
   status=source?'connected':'source_limit';
  }
 }
 await pool.query(`INSERT INTO tg_source_discussions(channel_source_id,discussion_source_id,peer_id,status) VALUES($1,$2,$3,$4)
  ON CONFLICT(channel_source_id) DO UPDATE SET discussion_source_id=EXCLUDED.discussion_source_id,peer_id=EXCLUDED.peer_id,status=EXCLUDED.status,checked_at=now()`,[sourceId,source,linked?.toString()??null,status]);
}
