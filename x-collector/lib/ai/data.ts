import { createHash } from 'node:crypto';
import { z } from 'zod';
import { q, tx } from '../trade/pg';
const DateTime=z.string().datetime({offset:true});
const Range=z.object({from:DateTime,to:DateTime,asOf:DateTime,batch:z.number().int().min(1).max(1000).default(500)}).refine(r=>Date.parse(r.from)<Date.parse(r.to),'from must precede to');
export interface AiInput {
 post_id:string;source_id:string;raw_hash:string;received_at:Date;posted_at:Date;
 text:string;author_id:string|null;author_handle:string|null;lang:string|null;
 metrics_observed_at:Date|null;metrics_received_at:Date|null;
 likes:string|null;views:string|null;reposts:string|null;replies:string|null;quotes:string|null;
 source_url:string;license:string;
}
/** All values were both observed and received by the cutoff. Current mutable rows are not features. */
export async function* exportInputs(raw:{from:string;to:string;asOf:string;batch?:number}) {
 const range=Range.parse(raw);let after='';
 for(;;){
  const rows=await q<AiInput>(`SELECT v.post_id,v.source_id,v.raw_hash,v.received_at,v.posted_at,v.text,v.author_id,v.author_handle,v.lang,
   m.metrics_observed_at,m.received_at metrics_received_at,m.likes::text,m.views::text,m.reposts::text,m.replies::text,m.quotes::text,s.url source_url,s.license
   FROM (SELECT id FROM archive_posts WHERE id>$1 AND first_received_at<=$2 AND posted_at>=$3 AND posted_at<$4 ORDER BY id LIMIT $5) p
   JOIN LATERAL (SELECT * FROM archive_post_versions WHERE post_id=p.id AND received_at<=$2 ORDER BY received_at DESC,source_id,raw_hash LIMIT 1) v ON true
   JOIN archive_sources s ON s.id=v.source_id
   LEFT JOIN LATERAL (SELECT * FROM archive_metrics WHERE post_id=p.id AND metrics_observed_at<=$2 AND received_at<=$2 ORDER BY metrics_observed_at DESC,received_at DESC,source_id,snapshot_key LIMIT 1) m ON true
   ORDER BY v.post_id`,[after,range.asOf,range.from,range.to,range.batch]);
  // Advance over candidates lacking a version as well (legacy rows have no fabricated history).
  const candidates=await q<{id:string}>(`SELECT id FROM archive_posts WHERE id>$1 AND first_received_at<=$2 AND posted_at>=$3 AND posted_at<$4 ORDER BY id LIMIT $5`,[after,range.asOf,range.from,range.to,range.batch]);
  for(const row of rows)yield {...row,input_hash:inputHash(row.text),feature_as_of:range.asOf};
  if(!candidates.length)return;
  after=candidates[candidates.length-1].id;
  if(candidates.length<range.batch)return;
 }
}
export function inputHash(text:string){return createHash('sha256').update(text,'utf8').digest('hex');}
const Model=z.object({name:z.string().min(1).max(120),version:z.string().min(1).max(120),task:z.string().min(1).max(120),dimensions:z.number().int().min(1).max(8192).nullable().default(null),metadata:z.record(z.unknown()).default({})}).strict();
export async function registerModel(raw:unknown){
 const m=Model.parse(raw);
 return tx(async c=>{
  await c.query('INSERT INTO ai_models(name,version,task,dimensions,metadata) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING',[m.name,m.version,m.task,m.dimensions,JSON.stringify(m.metadata)]);
  const found=await c.query('SELECT name FROM ai_models WHERE name=$1 AND version=$2 AND task=$3 AND dimensions IS NOT DISTINCT FROM $4 AND metadata=$5::jsonb',[m.name,m.version,m.task,m.dimensions,JSON.stringify(m.metadata)]);
  if(!found.rows.length)throw new Error('model version already registered with different configuration');
 });
}
const Result=z.object({postId:z.string().regex(/^\d+$/),sourceId:z.string().regex(/^[a-f0-9]{64}$/),rawHash:z.string().regex(/^[a-f0-9]{64}$/),modelName:z.string().min(1),modelVersion:z.string().min(1),inputHash:z.string().regex(/^[a-f0-9]{64}$/),result:z.record(z.unknown()),embedding:z.array(z.number().finite()).min(1).max(8192).optional()}).strict();
/** Immutable model output, tied to the exact captured text. No model is called by collection. */
export async function saveResult(raw:unknown){
 const r=Result.parse(raw);
 return tx(async c=>{
  const version=await c.query<{text:string}>('SELECT text FROM archive_post_versions WHERE post_id=$1 AND source_id=$2 AND raw_hash=$3',[r.postId,r.sourceId,r.rawHash]);
  if(!version.rows.length||inputHash(version.rows[0].text)!==r.inputHash)throw new Error('unknown version or mismatched input hash');
  const model=await c.query<{dimensions:number|null}>('SELECT dimensions FROM ai_models WHERE name=$1 AND version=$2',[r.modelName,r.modelVersion]);
  if(!model.rows.length||r.embedding&&r.embedding.length!==model.rows[0].dimensions)throw new Error('unknown model or mismatched embedding dimensions');
  const written=await c.query(`INSERT INTO ai_post_results(post_id,source_id,raw_hash,model_name,model_version,input_hash,result,embedding,dimensions)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT DO NOTHING RETURNING post_id`,[r.postId,r.sourceId,r.rawHash,r.modelName,r.modelVersion,r.inputHash,JSON.stringify(r.result),r.embedding??null,r.embedding?.length??null]);
  if(!written.rows.length){
   const same=await c.query(`SELECT post_id FROM ai_post_results WHERE post_id=$1 AND source_id=$2 AND raw_hash=$3 AND model_name=$4 AND model_version=$5 AND input_hash=$6 AND result=$7::jsonb AND embedding IS NOT DISTINCT FROM $8::float8[]`,[r.postId,r.sourceId,r.rawHash,r.modelName,r.modelVersion,r.inputHash,JSON.stringify(r.result),r.embedding??null]);
   if(!same.rows.length)throw new Error('result already exists; use a new model version');
  }
 });
}
