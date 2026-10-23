import {refreshTokenDailyCrossPlatform} from "./cross-platform.js";
import {parseTokenId} from "@claude-project/contracts";
import type {PgTransaction} from "./entity-registry.js";

type InvalidationRow={
  invalidation_id:unknown;canonical_token_id:unknown;source_system:unknown;
  event_kind:unknown;event_key:unknown;attempts:unknown;
};
/**
 * One transaction holds a FOR UPDATE SKIP LOCKED claim until the newly
 * versioned snapshots and audit are committed. Crash => entire batch rolls
 * back to queued, never losing the notification.
 *
 * Never infer the affected date from a queue arrival timestamp: recover the
 * original event day through the immutable Inbox evidence reference.
 */
export async function processInvalidationBatch(tx:PgTransaction,maxJobs=4):Promise<{
  completed:number;retried:number;failed:number;empty:boolean;
}> {
  if(!Number.isSafeInteger(maxJobs)||maxJobs<1||maxJobs>20)throw new RangeError("Invalid invalidation batch size");
  const counters={completed:0,retried:0,failed:0,empty:false};
  for(let i=0;i<maxJobs;i++){
    await tx.query("BEGIN");
    let savepoint=false;
    try{
      const claim=await tx.query(`SELECT invalidation_id,canonical_token_id,source_system,
        event_kind,event_key,attempts FROM analytics_invalidation_queue
        WHERE status='queued'
        ORDER BY queued_at,invalidation_id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if(!claim.rows.length){
        await tx.query("COMMIT");counters.empty=true;break;
      }
      const item=claim.rows[0] as InvalidationRow;
      const id=Number(item.invalidation_id);
      const token=String(item.canonical_token_id);
      const canonicalToken=parseTokenId(token);
      if(!Number.isSafeInteger(id)||id<1||!canonicalToken||canonicalToken.id!==token)
        throw new Error("invalidation_identity_invalid");
      await tx.query("UPDATE analytics_invalidation_queue SET status='processing',attempts=attempts+1 WHERE invalidation_id=$1",[id]);
      await tx.query("SAVEPOINT invalidation_refresh");savepoint=true;
      try{
        // An edit/delete/invalidation references its prior evidence's original
        // publication day, NOT the day on which the correction was delivered.
        const matched=await tx.query(`SELECT DISTINCT (t.occurred_at AT TIME ZONE 'UTC')::date::text AS day
          FROM intelligence_inbox origin
          JOIN timeline_events t ON t.source_system=origin.source_system
            AND t.evidence_source_id=origin.evidence_source_id
          WHERE origin.source_system=$1 AND origin.event_kind=$2 AND origin.event_key=$3
            AND t.source_system IN ('x','tg')
          ORDER BY day LIMIT 8`,[item.source_system,item.event_kind,item.event_key]);
        const days=matched.rows.map(row=>String(row.day));
        if(!days.length||days.length>7||days.some(day=>!/^\d{4}-\d{2}-\d{2}$/.test(day)))
          throw new Error("invalidation_day_unavailable");
        const now=(await tx.query("SELECT clock_timestamp() AS at")).rows[0]?.at;
        if(!(now instanceof Date)&&typeof now!=="string")throw new Error("invalidation_clock_unavailable");
        for(const day of days)await refreshTokenDailyCrossPlatform(tx,canonicalToken.id,day,now);
        await tx.query("RELEASE SAVEPOINT invalidation_refresh");savepoint=false;
        await tx.query("UPDATE analytics_invalidation_queue SET status='completed',processed_at=clock_timestamp() WHERE invalidation_id=$1",[id]);
        await tx.query(`INSERT INTO analytics_invalidation_log(invalidation_id,transition,artifact_key)
          VALUES($1,'recomputed',$2)`,[id,token+"|"+days.join(",")]);
        await tx.query("COMMIT");counters.completed++;
      }catch{
        if(savepoint){await tx.query("ROLLBACK TO SAVEPOINT invalidation_refresh");savepoint=false;}
        const terminal=Number(item.attempts)+1>=5;
        await tx.query(`UPDATE analytics_invalidation_queue
          SET status=$2,processed_at=CASE WHEN $2='failed' THEN clock_timestamp() ELSE NULL END
          WHERE invalidation_id=$1`,[id,terminal?"failed":"queued"]);
        await tx.query(`INSERT INTO analytics_invalidation_log(invalidation_id,transition)
          VALUES($1,'failed')`,[id]);
        await tx.query("COMMIT");
        if(terminal)counters.failed++;else counters.retried++;
      }
    }catch(error){
      try{await tx.query("ROLLBACK")}catch{}
      throw error;
    }
  }
  return counters;
}
