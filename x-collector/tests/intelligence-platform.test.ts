import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import type {PoolClient} from 'pg';
import {recordRaw,normalizeRaw,link,ruleTags} from '../lib/trade/intelligence-store';

test('intelligence preserves evidence, observations and temporal history without fabricated wallet ownership',async()=>{
 const db=new PGlite();
 try{
  await db.exec(await fs.readFile('migrations/023_intelligence_platform.sql','utf8'));
  await db.exec(await fs.readFile('migrations/024_intelligence_temporal.sql','utf8'));
  const c={query:async(sql:string,params:unknown[])=>db.query(sql,params)} as unknown as Pick<PoolClient,'query'>;
  const at=new Date('2026-10-10T00:00:00Z');
  const t={id:'1000000000000000',text:'Solana memecoin @bob #crypto 0x123',authorHandle:'Alice',authorDisplayName:null,url:null,views:null,likes:5,retweets:0,replies:0,isVerified:false,postedAt:null,mentions:['bob'],hashtags:['crypto']};
  const id=await recordRaw(c,'TWEET',t.id,t,at,'collector');
  assert.equal(await recordRaw(c,'TWEET',t.id,t,at,'collector'),id);
  assert.notEqual(await recordRaw(c,'TWEET',t.id,t,new Date('2026-10-11'),'collector'),id);
  await normalizeRaw(c,{id,event_type:'TWEET',payload:t,collected_at:at});
  await normalizeRaw(c,{id,event_type:'TWEET',payload:t,collected_at:at});
  assert.equal((await db.query('SELECT * FROM ip_behavior_events')).rows.length,2);
  assert.equal((await db.query('SELECT * FROM ip_relation_evidence')).rows.length,2);
  assert.equal((await db.query("SELECT * FROM ip_entity_relations WHERE relation_type='OWNS_WALLET'")).rows.length,0);
  assert.equal((await db.query('SELECT * FROM ip_behavior_events WHERE timestamp IS NULL')).rows.length,2);
  const changed=await recordRaw(c,'TWEET',t.id,{...t,likes:6},new Date('2026-10-11'));
  assert.notEqual(changed,id);
  const relation=(await db.query<{id:string;source_entity_id:string;target_entity_id:string}>("SELECT * FROM ip_entity_relations WHERE relation_type='MENTION'")).rows[0];
  await db.query('UPDATE ip_entity_relations SET valid_to=$1 WHERE id=$2',[new Date('2026-10-11'),relation.id]);
  await link(c,relation.source_entity_id,relation.target_entity_id,'MENTION',changed,new Date('2026-10-12'));
  assert.equal((await db.query("SELECT * FROM ip_entity_relations WHERE relation_type='MENTION'")).rows.length,2);
  const p={handle:'alice',displayName:null,bio:'Solana',followers:100,following:5,postsCount:20,isVerified:false,joinedAt:null,avatarUrl:null};
  for(const followers of [100,200]){
   const payload={...p,followers},raw=await recordRaw(c,'PROFILE','alice',payload,at);
   await normalizeRaw(c,{id:raw,event_type:'PROFILE',payload,collected_at:at});
  }
  assert.equal((await db.query('SELECT * FROM ip_entity_snapshots')).rows.length,2);
  assert.equal((await db.query<{risk_score:null}>('SELECT risk_score FROM ip_entity_profiles')).rows[0].risk_score,null);
  assert.deepEqual(ruleTags('Solana мемкоин Трамп'),['crypto','solana','memecoin','politics']);
  await assert.rejects(db.query('DELETE FROM ip_raw_events WHERE id=$1',[id]));
 }finally{await db.close();}
});
