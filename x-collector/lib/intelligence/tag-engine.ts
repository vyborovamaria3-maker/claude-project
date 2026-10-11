import type {PoolClient} from 'pg';

type Client = Pick<PoolClient,'query'>;

export type TagSource = 'MANUAL'|'AI'|'RULE'|'GRAPH'|'BLOCKCHAIN';

export async function assignTag(
 c: Client,
 entityId: string,
 tagId: string,
 source: TagSource,
 confidence = 1,
 metadata = {}
){
 await c.query(
  `INSERT INTO ip_entity_tags(entity_id,tag_id,assigned_by,confidence,source_id)
   VALUES($1,$2,$3,$4,$3)
   ON CONFLICT(entity_id,tag_id)
   DO UPDATE SET confidence=EXCLUDED.confidence, source_id=EXCLUDED.source_id`,
  [entityId,tagId,source.toLowerCase(),confidence]
 );

 await c.query(
  `INSERT INTO ip_entity_tag_history(id,entity_id,tag_id,source_id,new_confidence,metadata)
   VALUES(gen_random_uuid(),$1,$2,$3,$4,$5::jsonb)`,
  [entityId,tagId,source,confidence,JSON.stringify(metadata)]
 );
}

export async function getEntityTags(c: Client, entityId:string){
 const result = await c.query(
  `SELECT t.*,et.confidence,et.source_id
   FROM ip_entity_tags et
   JOIN ip_tags t ON t.id=et.tag_id
   WHERE et.entity_id=$1
   ORDER BY et.confidence DESC`,
  [entityId]
 );
 return result.rows;
}
