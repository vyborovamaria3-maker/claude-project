import 'dotenv/config';
import {randomUUID} from 'node:crypto';
import {q,tx,closePool} from '../lib/trade/pg';
import {connectedComponents,pageRank} from '../lib/trade/intelligence-analytics';
async function main(){
 // Safety ceiling is explicit: never call a truncated sample a global graph.
 const rows=await q<{source:string;target:string;weight:number}>(`SELECT r.source_entity_id source,r.target_entity_id target,r.weight
  FROM ip_entity_relations r JOIN ip_entities a ON a.id=r.source_entity_id JOIN ip_entities b ON b.id=r.target_entity_id
  WHERE r.valid_to IS NULL AND a.type='ACCOUNT' AND b.type='ACCOUNT' ORDER BY r.id LIMIT 100001`);
 if(rows.length>100000)throw Error('Graph exceeds in-memory analytics ceiling; partitioned processing required');
 const clusters=connectedComponents(rows),rank=pageRank(rows),maximum=Math.max(0,...rank.values());
 await tx(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(742098535)');
  for(const [entity,value] of rank)await c.query(`INSERT INTO ip_entity_profiles(entity_id,influence_score,metadata) VALUES($1,$2,$3::jsonb)
   ON CONFLICT(entity_id) DO UPDATE SET influence_score=EXCLUDED.influence_score,metadata=ip_entity_profiles.metadata||EXCLUDED.metadata,updated_at=now()`,[entity,maximum?value/maximum:0,JSON.stringify({influence_method:'pagerank_relative_observed_account_graph',pagerank:value,edges:rows.length})]);
  for(const members of clusters){
   const id=randomUUID();await c.query(`INSERT INTO ip_graph_clusters(id,name,score,metadata) VALUES($1,$2,NULL,$3::jsonb)`,[id,'Observed account component ('+members.length+')',JSON.stringify({algorithm:'connected_components',scope:'observed_account_graph',members:members.length})]);
   await c.query('INSERT INTO ip_cluster_members(cluster_id,entity_id) SELECT $1,unnest($2::uuid[])',[id,members]);
  }
 });
 console.log(JSON.stringify({edges:rows.length,ranked_accounts:rank.size,clusters:clusters.length}));
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Graph analytics failed');process.exitCode=1;}).finally(closePool);
