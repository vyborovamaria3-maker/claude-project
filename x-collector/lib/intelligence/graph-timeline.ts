import type {PoolClient} from 'pg';

export type GraphTimelineEvent={
 relationId:string;
 eventType:string;
 weightDelta?:number;
 confidenceDelta?:number;
 metadata?:Record<string,unknown>;
};

type Client=Pick<PoolClient,'query'>;

export async function recordRelationEvent(client:Client,event:GraphTimelineEvent){
 await client.query(
  `INSERT INTO ip_relation_events(id,relation_id,event_type,weight_delta,confidence_delta,metadata)
   VALUES(gen_random_uuid(),$1,$2,$3,$4,$5::jsonb)`,
  [event.relationId,event.eventType,event.weightDelta??0,event.confidenceDelta??0,JSON.stringify(event.metadata??{})]
 );
}

export async function getRelationTimeline(client:Client,relationId:string){
 const result=await client.query(
  `SELECT id,event_type,weight_delta,confidence_delta,metadata,created_at
   FROM ip_relation_events
   WHERE relation_id=$1
   ORDER BY created_at ASC,id ASC`,
  [relationId]
 );
 return result.rows;
}
