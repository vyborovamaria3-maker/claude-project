import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {TweetSchema,ProfileSchema} from './schemas';

type Client=Pick<PoolClient,'query'>;
export async function recordRawBatch(c:Client,events:{eventType:'TWEET'|'PROFILE';externalId:string;payload:unknown;collectedAt:Date;collectorAccount?:string|null}[]){
 if(!events.length)return;
 const rows=events.map(e=>({id:randomUUID(),event_type:e.eventType,external_id:e.externalId,payload:e.payload,
  payload_hash:createHash('sha256').update(JSON.stringify(e.payload)).digest('hex'),collected_at:e.collectedAt.toISOString(),collector_account:e.collectorAccount??null}));
 await c.query(`INSERT INTO ip_raw_events(id,source,event_type,external_id,payload,payload_hash,collected_at,collector_account)
  SELECT x.id,'X',x.event_type,x.external_id,x.payload,x.payload_hash,x.collected_at,x.collector_account
  FROM jsonb_to_recordset($1::jsonb) x(id uuid,event_type text,external_id text,payload jsonb,payload_hash text,collected_at timestamptz,collector_account text)
  ON CONFLICT(source,event_type,external_id,payload_hash,collected_at) DO NOTHING`,[JSON.stringify(rows)]);
}
export async function recordRaw(c:Client,eventType:'TWEET'|'PROFILE',externalId:string,payload:unknown,collectedAt:Date,collectorAccount:string|null=null){
 const json=JSON.stringify(payload),hash=createHash('sha256').update(json).digest('hex');
 const r=await c.query<{id:string}>(`INSERT INTO ip_raw_events(id,source,event_type,external_id,payload,payload_hash,collector_account,collected_at)
 VALUES($1,'X',$2,$3,$4::jsonb,$5,$6,$7) ON CONFLICT(source,event_type,external_id,payload_hash,collected_at)
 DO UPDATE SET external_id=EXCLUDED.external_id RETURNING id`,[randomUUID(),eventType,externalId,json,hash,collectorAccount,collectedAt]);
 return r.rows[0].id;
}
export async function resolveEntity(c:Client,type:string,platform:string,externalId:string,name:string){
 const r=await c.query<{id:string}>(`INSERT INTO ip_entities(id,type,platform,external_id,name) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(type,platform,external_id) DO UPDATE SET name=EXCLUDED.name,updated_at=now() RETURNING id`,[randomUUID(),type,platform,externalId,name]);
 return r.rows[0].id;
}
export async function link(c:Client,source:string,target:string,kind:string,rawId:string,observed:Date,confidence=1){
 const r=await c.query<{id:string}>(`INSERT INTO ip_entity_relations(id,source_entity_id,target_entity_id,relation_type,confidence,first_seen,last_seen,valid_from,source_event_id)
 VALUES($1,$2,$3,$4,$5,$6,$6,$6,$7) ON CONFLICT(source_entity_id,target_entity_id,relation_type) WHERE valid_to IS NULL
 DO UPDATE SET first_seen=LEAST(ip_entity_relations.first_seen,EXCLUDED.first_seen),last_seen=GREATEST(ip_entity_relations.last_seen,EXCLUDED.last_seen),valid_from=LEAST(ip_entity_relations.valid_from,EXCLUDED.valid_from) RETURNING id`,[randomUUID(),source,target,kind,confidence,observed,rawId]);
 await c.query(`INSERT INTO ip_relation_evidence(id,relation_id,source_type,source_id,confidence) SELECT $1,$2,CASE WHEN event_type='TRANSACTION' THEN 'BLOCKCHAIN' ELSE source END,id,$4 FROM ip_raw_events WHERE id=$3 ON CONFLICT DO NOTHING`,[randomUUID(),r.rows[0].id,rawId,confidence]);
 await c.query(`UPDATE ip_entity_relations SET weight=(SELECT count(DISTINCT raw.external_id)::double precision FROM ip_relation_evidence e JOIN ip_raw_events raw ON raw.id=e.source_id WHERE e.relation_id=$1),
  confidence=GREATEST(confidence,$2) WHERE id=$1`,[r.rows[0].id,confidence]);
 return r.rows[0].id;
}
const rules:[string,RegExp][]=[['crypto',/\b(crypto|blockchain|solana|ethereum|memecoin)\b|крипт|блокчейн|мемкоин/iu],['solana',/\bsolana\b|солана/iu],['ethereum',/\bethereum\b|эфириум/iu],['defi',/\bdefi\b/iu],['nft',/\bnfts?\b/iu],['gaming',/\bgaming\b/iu],['memecoin',/\bmemecoins?\b|мемкоин/iu],['memes',/\bmemes?\b|мемы/iu],['politics',/\b(politics|political|trump)\b|политик|трамп/iu]];
export function ruleTags(text:string){return rules.filter(([,pattern])=>pattern.test(text)).map(([tag])=>tag);}
async function tag(c:Client,entity:string,text:string,rawId:string){
 for(const id of ruleTags(text))await c.query(`INSERT INTO ip_entity_tags(entity_id,tag_id,assigned_by,confidence,source_id) VALUES($1,$2,'rule',0.7,$3) ON CONFLICT DO NOTHING`,[entity,id,rawId]);
}
export async function normalizeRaw(c:Client,raw:{id:string;event_type:string;payload:unknown;collected_at:Date}){
 const observed=new Date(raw.collected_at);
 if(raw.event_type==='TWEET'){
  const t=TweetSchema.parse(raw.payload),handle=t.authorHandle.replace(/^@/,'').toLowerCase();
  const actor=await resolveEntity(c,'ACCOUNT','X',handle,'@'+handle);
  await c.query(`INSERT INTO ip_entity_profiles(entity_id,metadata) VALUES($1,'{"scores_status":"not_computed","identity_basis":"observed_handle"}') ON CONFLICT DO NOTHING`,[actor]);
  // A publication is represented by a behavior event, not a fake PERSON entity.
  await c.query(`INSERT INTO ip_behavior_events(id,actor_entity,event_type,timestamp,raw_event_id,external_id,metadata)
   VALUES($1,$2,'POST',$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,[randomUUID(),actor,t.postedAt===null?null:new Date(t.postedAt),raw.id,t.id,JSON.stringify({text:t.text,url:t.url})]);
  await tag(c,actor,t.text,raw.id);
  for(const handle of new Set(t.mentions??[])){
   const target=await resolveEntity(c,'ACCOUNT','X',handle.toLowerCase(),'@'+handle.toLowerCase());
   await link(c,actor,target,'MENTION',raw.id,observed);
   await c.query(`INSERT INTO ip_behavior_events(id,actor_entity,target_entity,event_type,timestamp,raw_event_id,external_id)
    VALUES($1,$2,$3,'MENTION',$4,$5,$6) ON CONFLICT DO NOTHING`,[randomUUID(),actor,target,t.postedAt===null?null:new Date(t.postedAt),raw.id,t.id+':'+handle.toLowerCase()]);
  }
  for(const hashtag of new Set(t.hashtags??[])){
   const name=hashtag.replace(/^#/,'').toLowerCase();if(!name)continue;
   const topic=await resolveEntity(c,'TOPIC','X',name,'#'+name);await link(c,actor,topic,'DISCUSSED',raw.id,observed);
  }
  // Visible reference IDs alone do not prove reply/retweet/quote semantics.
 }else if(raw.event_type==='PROFILE'){
  const p=ProfileSchema.parse(raw.payload),handle=p.handle.toLowerCase(),entity=await resolveEntity(c,'ACCOUNT','X',handle,'@'+handle);
  await c.query(`INSERT INTO ip_entity_snapshots(id,entity_id,raw_event_id,observed_at,payload) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,[randomUUID(),entity,raw.id,observed,JSON.stringify(p)]);
  await c.query(`INSERT INTO ip_entity_profiles(entity_id,metadata) VALUES($1,'{"scores_status":"not_computed"}') ON CONFLICT DO NOTHING`,[entity]);
  await tag(c,entity,[p.handle,p.bio??''].join(' '),raw.id);
 }else throw new Error('Unsupported raw event type');
 await c.query('UPDATE ip_raw_events SET normalized_at=now() WHERE id=$1',[raw.id]);
}
