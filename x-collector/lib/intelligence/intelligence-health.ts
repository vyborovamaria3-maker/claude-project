import type {PoolClient} from "pg";
import {REQUIRED} from "../trade/migrations";

type Client=Pick<PoolClient,"query">;

export type HealthCheck={name:string;ok:boolean;detail:string};

export type IntelligenceHealth={
 status:"healthy"|"degraded"|"unavailable";
 checks:HealthCheck[];
 counts:Record<string,number>;
 checkedAt:string;
};

export type HealthLimits={
 pendingNormalization:number;
 pendingAgeHours:number;
 openInvestigations:number;
};

const DEFAULT_LIMITS:HealthLimits={pendingNormalization:1000,pendingAgeHours:24,openInvestigations:50};

const REQUIRED_TABLES=[
 "ip_entities","ip_raw_events","ip_entity_relations","ip_relation_evidence",
 "ip_entity_profiles","ip_entity_snapshots","ip_entity_embeddings",
 "ip_investigations","ip_investigation_steps","ip_audit_log",
];

function count(value:string|number|undefined):number{
 const parsed=Number(value);
 return Number.isFinite(parsed)?parsed:0;
}

function hoursFromSeconds(value:string|number|undefined):number{
 const parsed=Number(value);
 return Number.isFinite(parsed)&&parsed>0?parsed/3600:0;
}

export async function checkIntelligenceHealth(c:Client,limits:HealthLimits=DEFAULT_LIMITS):Promise<IntelligenceHealth>{
 const checks:HealthCheck[]=[];
 const counts:Record<string,number>={};
 try{
  const tables=await c.query<{present:number}>(
   `SELECT count(*)::int present FROM unnest($1::text[]) AS n(name) WHERE to_regclass(n.name) IS NOT NULL`,
   [REQUIRED_TABLES]);
  const present=tables.rows[0]?.present??0;
  checks.push({name:"tables",ok:present===REQUIRED_TABLES.length,detail:`${present}/${REQUIRED_TABLES.length} intelligence tables present`});
  if(present!==REQUIRED_TABLES.length)return{status:"unavailable",checks,counts,checkedAt:new Date().toISOString()};

  const migrationsTable=await c.query<{present:boolean}>(
   `SELECT to_regclass('schema_migrations') IS NOT NULL AS present`);
  if(!migrationsTable.rows[0]?.present){
   checks.push({name:"migrations",ok:false,detail:"schema_migrations table is missing"});
  }else{
   const migrations=await c.query<{applied:number}>(
    `SELECT count(*)::int applied FROM schema_migrations WHERE filename=ANY($1::text[])`,[REQUIRED]);
   const applied=migrations.rows[0]?.applied??0;
   checks.push({name:"migrations",ok:applied===REQUIRED.length,detail:`${applied}/${REQUIRED.length} required migrations applied`});
  }

  const totals=await c.query<{entities:string;raw_events:string;pending:string;relations:string;evidence:string;investigations:string}>(
   `SELECT (SELECT count(*)::text FROM ip_entities) entities,
           (SELECT count(*)::text FROM ip_raw_events) raw_events,
           (SELECT count(*)::text FROM ip_raw_events WHERE normalized_at IS NULL) pending,
           (SELECT count(*)::text FROM ip_entity_relations WHERE valid_to IS NULL) relations,
           (SELECT count(*)::text FROM ip_relation_evidence) evidence,
           (SELECT count(*)::text FROM ip_investigations WHERE status IN ('OPEN','ACTIVE')) investigations`);
  const total=totals.rows[0]??{entities:"0",raw_events:"0",pending:"0",relations:"0",evidence:"0",investigations:"0"};
  counts.entities=count(total.entities);
  counts.raw_events=count(total.raw_events);
  counts.pending_normalizations=count(total.pending);
  counts.relations=count(total.relations);
  counts.evidence=count(total.evidence);
  counts.open_investigations=count(total.investigations);

  checks.push({name:"storage",ok:true,detail:`entities=${counts.entities} relations=${counts.relations} evidence=${counts.evidence}`});

  const unsourced=await c.query<{count:string}>(
   `SELECT count(*)::text count FROM ip_entity_relations WHERE valid_to IS NULL AND source_event_id IS NULL`);
  counts.unsourced_relations=count(unsourced.rows[0]?.count);
  checks.push({name:"evidence_first",ok:counts.unsourced_relations===0,detail:`active relations without a durable source event: ${counts.unsourced_relations}`});

  const pendingAgeSeconds=counts.pending_normalizations
   ?Number((await c.query<{age:string}>(
     `SELECT COALESCE(max(EXTRACT(EPOCH FROM (now()-collected_at))),0)::text age FROM ip_raw_events WHERE normalized_at IS NULL`)).rows[0]?.age??"0")
   :0;
  const pendingHours=hoursFromSeconds(pendingAgeSeconds);
  checks.push({
   name:"normalization_queue",
   ok:counts.pending_normalizations<=limits.pendingNormalization&&pendingHours<=limits.pendingAgeHours,
   detail:`pending=${counts.pending_normalizations} oldest_age_hours=${pendingHours.toFixed(2)}`,
  });

  checks.push({
   name:"investigation_queue",
   ok:counts.open_investigations<=limits.openInvestigations,
   detail:`open_or_active=${counts.open_investigations}`,
  });

  const failed=checks.filter((check)=>!check.ok);
  return{status:failed.length?"degraded":"healthy",checks,counts,checkedAt:new Date().toISOString()};
 }catch(error){
  checks.push({name:"database",ok:false,detail:error instanceof Error?error.message:"database unreachable"});
  return{status:"unavailable",checks,counts,checkedAt:new Date().toISOString()};
 }
}
