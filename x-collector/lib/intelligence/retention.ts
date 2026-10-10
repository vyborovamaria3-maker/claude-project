import type {PoolClient} from "pg";

type Client=Pick<PoolClient,"query">;

export class RetentionError extends Error{}

export type RetentionOptions={
 snapshotDays?:number;
 batchSize?:number;
 dryRun?:boolean;
};

export type RetentionReport={
 dryRun:boolean;
 snapshotDays:number;
 batchSize:number;
 snapshots:number;
 oldestDeletedAt:string|null;
 protectedTables:string[];
};

const PROTECTED=["ip_raw_events","ip_relation_evidence","ip_entity_relations","ip_investigation_steps"];

function positiveInteger(value:number|undefined,fallback:number,label:string):number{
 const parsed=value??fallback;
 if(!Number.isInteger(parsed)||parsed<1)throw new RetentionError(`${label} must be a positive integer`);
 return parsed;
}

export async function applyIntelligenceRetention(c:Client,options:RetentionOptions={}):Promise<RetentionReport>{
 const snapshotDays=positiveInteger(options.snapshotDays,365,"snapshotDays");
 if(snapshotDays>3650)throw new RetentionError("snapshotDays must be at most 3650");
 const batchSize=positiveInteger(options.batchSize,5000,"batchSize");
 if(batchSize>50000)throw new RetentionError("batchSize must be at most 50000");
 const dryRun=options.dryRun??false;

 const stale=await c.query<{id:string;observed_at:Date}>(
  `SELECT id,observed_at FROM ip_entity_snapshots
   WHERE observed_at < now() - make_interval(days=>$1)
   ORDER BY observed_at,id LIMIT $2`,[snapshotDays,batchSize]);
 const oldest=stale.rows[0]?.observed_at??null;
 if(dryRun||!stale.rows.length){
  return{
   dryRun,
   snapshotDays,
   batchSize,
   snapshots:stale.rows.length,
   oldestDeletedAt:oldest?new Date(oldest).toISOString():null,
   protectedTables:[...PROTECTED],
  };
 }
 const ids=stale.rows.map((row)=>row.id);
 const deleted=await c.query<{count:string}>(
  "DELETE FROM ip_entity_snapshots WHERE id=ANY($1::uuid[]) RETURNING id",[ids]);
 return{
  dryRun:false,
  snapshotDays,
  batchSize,
  snapshots:Number(deleted.rows.length),
  oldestDeletedAt:oldest?new Date(oldest).toISOString():null,
  protectedTables:[...PROTECTED],
 };
}
