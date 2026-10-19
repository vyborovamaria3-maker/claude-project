import {pool}from '../db.js';
import {matchesSearchTerm}from './message-search.js';
/** Seed the mention index from real already-collected public history; no synthetic posts. */
export async function indexKnownMentions(){
 const tx=await pool.connect();
 try{
  await tx.query('BEGIN');
  const settings=(await tx.query<{message_terms:string[]}>(`SELECT d.message_terms FROM tg_discovery_settings d CROSS JOIN tg_runtime r
   WHERE d.id=1 AND r.id=1 AND d.enabled AND d.message_search_enabled AND r.collection_enabled
   AND r.block_reason IS NULL AND (r.pause_until IS NULL OR r.pause_until<=now()) FOR SHARE OF d,r`)).rows[0];
  if(!settings){await tx.query('ROLLBACK');return;}
  const rows=await tx.query<{id:string;peer_id:string;identifier:string;title:string;enabled:boolean;message_id:string;text:string;posted_at:Date|null}>(`SELECT s.id::text,s.peer_id,s.identifier,s.title,s.enabled,m.message_id::text,m.text,m.posted_at
   FROM tg_messages m JOIN tg_sources s ON s.id=m.source_id WHERE s.peer_id IS NOT NULL AND m.deleted_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM tg_discovery_mentions x WHERE x.peer_id=s.peer_id AND x.message_id=m.message_id)
   AND EXISTS(SELECT 1 FROM unnest($1::text[])term WHERE position(lower(term)in lower(m.text))>0)
   ORDER BY m.posted_at DESC LIMIT 1000`,[settings.message_terms]);
  for(const row of rows.rows){
   const terms=settings.message_terms.filter(t=>matchesSearchTerm(row.text,t));if(!terms.length)continue;
   await tx.query(`INSERT INTO tg_discovery_mentions(peer_id,message_id,username,title,text,posted_at,matched_terms,source_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[row.peer_id,row.message_id,row.identifier,row.title??row.identifier,row.text.slice(0,8192),row.posted_at,terms,row.id]);
   if(row.enabled)await tx.query('UPDATE tg_sources SET full_history=TRUE WHERE id=$1',[row.id]);
  }
  await tx.query('COMMIT');
 }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}
