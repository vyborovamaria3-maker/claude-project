import {NextRequest,NextResponse} from 'next/server';
import {requireProdAuth} from './routeAuth';
import {collectorDatabase,AccountError} from './xcollector-accounts';

const uuid=(id:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
export async function intelligenceGET(request:NextRequest,resource:string,id?:string){
 try{
  const auth=await requireProdAuth(request);if(auth)return auth;
  const db=collectorDatabase(),p=new URL(request.url).searchParams;
  const rawLimit=p.get('limit')??'50',rawOffset=p.get('offset')??'0';
  if(!/^\d{1,3}$/.test(rawLimit)||!/^\d{1,7}$/.test(rawOffset))throw new AccountError('Некорректная пагинация');
  const limit=Math.min(200,Math.max(1,Number(rawLimit))),offset=Number(rawOffset);
  if(id&&resource!=='wallet'&&!uuid(id))throw new AccountError('Некорректный ID');
  let data:unknown;
  if(resource==='entities'||resource==='nodes'){
   const q=p.get('q')??'',type=p.get('type');if(q.length>200)throw new AccountError('Слишком длинный запрос');
   data=(await db.query(`SELECT e.*,p.influence_score,p.risk_score FROM ip_entities e LEFT JOIN ip_entity_profiles p ON p.entity_id=e.id
    WHERE ($1::text IS NULL OR e.type=$1) AND ($2='' OR e.name ILIKE '%'||$2||'%') ORDER BY e.id LIMIT $3 OFFSET $4`,[type,q,limit,offset])).rows;
  }else if(resource==='entity'&&id){
   const entity=(await db.query('SELECT * FROM ip_entities WHERE id=$1',[id])).rows[0];if(!entity)throw new AccountError('Сущность не найдена',404);
   const [profile,tags,history,relations,clusters]=await Promise.all([
    db.query('SELECT * FROM ip_entity_profiles WHERE entity_id=$1',[id]),
    db.query(`SELECT t.id,t.name,max(et.confidence) confidence,array_agg(DISTINCT et.assigned_by) assigned_by FROM ip_entity_tags et JOIN ip_tags t ON t.id=et.tag_id WHERE entity_id=$1 GROUP BY t.id,t.name`,[id]),
    db.query('SELECT observed_at,payload FROM ip_entity_snapshots WHERE entity_id=$1 ORDER BY observed_at DESC LIMIT $2',[id,limit]),
    db.query('SELECT count(*)::int count FROM ip_entity_relations WHERE (source_entity_id=$1 OR target_entity_id=$1) AND valid_to IS NULL',[id]),
    db.query('SELECT c.* FROM ip_graph_clusters c JOIN ip_cluster_members m ON m.cluster_id=c.id WHERE m.entity_id=$1 LIMIT $2',[id,limit])]);
   data={entity,profile:profile.rows[0]??null,tags:tags.rows,history:history.rows,relations:relations.rows[0].count,clusters:clusters.rows};
  }else if(resource==='edges'||resource==='relations'){
   const node=p.get('entity'),at=p.get('at');if(node&&!uuid(node))throw new AccountError('Некорректная сущность');
   if(at&&!Number.isFinite(Date.parse(at)))throw new AccountError('Некорректная дата');
   data=(await db.query(`SELECT r.*,e.evidence_count FROM ip_entity_relations r
    CROSS JOIN LATERAL (SELECT count(*)::int evidence_count FROM ip_relation_evidence WHERE relation_id=r.id) e
    WHERE ($1::uuid IS NULL OR source_entity_id=$1 OR target_entity_id=$1)
    AND (CASE WHEN $2::timestamptz IS NULL THEN valid_to IS NULL ELSE valid_from<=$2 AND (valid_to IS NULL OR valid_to>$2) END)
    ORDER BY r.id LIMIT $3 OFFSET $4`,[node,at,limit,offset])).rows;
  }else if(resource==='analytics'){
   const entity=p.get('entity');if(!entity||!uuid(entity))throw new AccountError('Укажите entity');
   const [neighbors,shared,leaders]=await Promise.all([
    db.query(`SELECT e.*,r.relation_type,r.weight,r.confidence,r.id relation_id FROM ip_entity_relations r JOIN ip_entities e
      ON e.id=CASE WHEN source_entity_id=$1 THEN target_entity_id ELSE source_entity_id END
      WHERE (source_entity_id=$1 OR target_entity_id=$1) AND valid_to IS NULL ORDER BY weight DESC,r.id LIMIT $2`,[entity,limit]),
    db.query(`SELECT e.id,e.name,count(DISTINCT a.target_entity_id)::int shared_targets FROM ip_entity_relations a JOIN ip_entity_relations b ON a.target_entity_id=b.target_entity_id
      JOIN ip_entities e ON e.id=b.source_entity_id WHERE a.source_entity_id=$1 AND b.source_entity_id<>$1 AND a.valid_to IS NULL AND b.valid_to IS NULL
      GROUP BY e.id,e.name ORDER BY shared_targets DESC,e.id LIMIT $2`,[entity,limit]),
    db.query(`SELECT e.id,e.name,p.influence_score,p.metadata FROM ip_entity_profiles p JOIN ip_entities e ON e.id=p.entity_id WHERE influence_score IS NOT NULL ORDER BY influence_score DESC,e.id LIMIT $1`,[limit])]);
   data={neighbors:neighbors.rows,shared_targets:shared.rows,leaders:leaders.rows,note:'Общие цели взаимодействий — наблюдаемый паттерн, а не доказательство общей личности или координации'};
  }else if(resource==='evidence'&&id){
   data=(await db.query(`SELECT e.*,r.source,r.event_type,r.external_id,r.payload,r.collected_at FROM ip_relation_evidence e JOIN ip_raw_events r ON r.id=e.source_id WHERE relation_id=$1 ORDER BY e.created_at LIMIT $2 OFFSET $3`,[id,limit,offset])).rows;
  }else if(resource==='tags'){
   data={categories:(await db.query('SELECT * FROM ip_tag_categories ORDER BY id')).rows,tags:(await db.query('SELECT * FROM ip_tags ORDER BY category_id,id')).rows};
  }else if(resource==='clusters'){
   data=(await db.query(`SELECT c.*, (SELECT count(*)::int FROM ip_cluster_members WHERE cluster_id=c.id) member_count FROM ip_graph_clusters c ORDER BY computed_at DESC,id LIMIT $1 OFFSET $2`,[limit,offset])).rows;
  }else if(resource==='similar'){
   const entity=p.get('entity'),model=p.get('model');
   if(!entity||!uuid(entity)||!model||model.length>200)throw new AccountError('Нужны entity и model');
   const reference=(await db.query('SELECT vector,dimensions FROM ip_entity_embeddings WHERE entity_id=$1 AND model=$2',[entity,model])).rows[0];
   if(!reference)throw new AccountError('Embedding этой сущности для указанной модели ещё не создан',409);
   const count=Number((await db.query('SELECT count(*)::text count FROM ip_entity_embeddings WHERE model=$1 AND dimensions=$2',[model,reference.dimensions])).rows[0].count);
   if(count>50000)throw new AccountError('Для такого объёма требуется индекс векторного поиска; полный скан отключён',503);
   data=(await db.query(`SELECT e.id,e.name,e.type,s.similarity FROM ip_entity_embeddings v JOIN ip_entities e ON e.id=v.entity_id
    CROSS JOIN LATERAL (SELECT sum(a.value*b.value)/NULLIF(sqrt(sum(a.value*a.value)*sum(b.value*b.value)),0) similarity
     FROM unnest(v.vector) WITH ORDINALITY a(value,i) JOIN unnest($1::double precision[]) WITH ORDINALITY b(value,i) USING(i)) s
    WHERE v.model=$2 AND v.dimensions=$3 AND v.entity_id<>$4 AND s.similarity IS NOT NULL
    ORDER BY s.similarity DESC,e.id LIMIT $5`,[reference.vector,model,reference.dimensions,entity,limit])).rows;
  }else if(resource==='wallet'&&id){
   const chain=p.get('chain');if(!chain||chain.length>50||id.length>200)throw new AccountError('Укажите chain и адрес кошелька');
   data=(await db.query("SELECT * FROM ip_entities WHERE type='WALLET' AND platform=$1 AND external_id=$2",[chain,id])).rows[0];
   if(!data)throw new AccountError('Кошелёк не найден',404);
  }else if(resource==='overview'){
   data=(await db.query(`SELECT (SELECT count(*)::text FROM ip_entities) entities,(SELECT count(*)::text FROM ip_raw_events) raw_events,
    (SELECT count(*)::text FROM ip_raw_events WHERE normalized_at IS NULL) pending,(SELECT count(*)::text FROM ip_entity_relations WHERE valid_to IS NULL) relations,
    (SELECT count(*)::text FROM ip_entity_snapshots) snapshots`)).rows[0];
  }else throw new AccountError('Ресурс не найден',404);
  return NextResponse.json({data,limit,offset},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return NextResponse.json({error:error instanceof AccountError?error.message:'Intelligence недоступен. Проверьте миграции и базу.'},{status:error instanceof AccountError?error.status:503});}
}
