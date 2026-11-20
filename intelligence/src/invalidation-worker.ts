import {refreshTokenDailyCrossPlatform} from "./cross-platform.js";
import {parseTokenId} from "@claude-project/contracts";
import type {PgTransaction} from "./entity-registry.js";

type InvalidationRow={
  invalidation_id:unknown;canonical_token_id:unknown;source_system:unknown;
  event_kind:unknown;event_key:unknown;attempts:unknown;next_day:unknown;
};
type InvalidationOptions={
  maxDaysPerJob?:number;
  refreshSnapshot?:typeof refreshTokenDailyCrossPlatform;
};
/**
 * Recompute every already-published daily snapshot at or after the earliest
 * affected source day. First-mention/first-trade fields depend on full history.
 * Work is cursor-paginated so old corrections do not hold one huge transaction.
 */
export async function processInvalidationBatch(
  tx:PgTransaction,maxJobs=4,options:InvalidationOptions={},
):Promise<{completed:number;continued:number;retried:number;failed:number;empty:boolean}> {
  if(!Number.isSafeInteger(maxJobs)||maxJobs<1||maxJobs>20)
    throw new RangeError("Invalid invalidation batch size");
  const maxDays=options.maxDaysPerJob??31;
  if(!Number.isSafeInteger(maxDays)||maxDays<1||maxDays>366)
    throw new RangeError("Invalid invalidation day chunk size");
  const refresh=options.refreshSnapshot??refreshTokenDailyCrossPlatform;
  const counters={completed:0,continued:0,retried:0,failed:0,empty:false};
  for(let i=0;i<maxJobs;i++){
    await tx.query("BEGIN");
    let savepoint=false;
    try{
      const claim=await tx.query(`SELECT invalidation_id,canonical_token_id,source_system,
        event_kind,event_key,attempts,next_day FROM analytics_invalidation_queue
        WHERE status='queued' AND next_attempt_at<=clock_timestamp()
        ORDER BY next_attempt_at,queued_at,invalidation_id LIMIT 1 FOR UPDATE SKIP LOCKED`);
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
        // Not every source event is a generic timeline event: verified token
        // links and their retractions intentionally have no timelineEvent.
        // entity_evidence is written for every validated registry event in the
        // same transaction as the inbox row, so it is the canonical clock for
        // both timeline-backed revisions and evidence-only link assertions.
        const matched=await tx.query(`SELECT MIN((COALESCE(e.occurred_at,e.observed_at)
            AT TIME ZONE 'UTC')::date)::text AS day
          FROM intelligence_inbox origin
          JOIN entity_evidence e ON e.source_system=origin.source_system
            AND e.event_kind=origin.event_kind AND e.event_key=origin.event_key
          WHERE origin.source_system=$1 AND origin.event_kind=$2 AND origin.event_key=$3
            AND e.evidence_kind IN ('x_tweet','tg_message')`,[item.source_system,item.event_kind,item.event_key]);
        const earliestDay=matched.rows[0]?.day;
        const startDay=item.next_day==null?earliestDay:String(item.next_day);
        if(typeof startDay!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(startDay))
          throw new Error("invalidation_day_unavailable");
        const dayResult=await tx.query(`SELECT DISTINCT day::text AS day FROM token_daily_cross_platform
          WHERE canonical_token_id=$1 AND day>=COALESCE($2::date,$3::date)
          ORDER BY day LIMIT $4`,[token,item.next_day??null,earliestDay,maxDays+1]);
        const dayRows=dayResult.rows;
        if(!dayRows.length){
          await tx.query("RELEASE SAVEPOINT invalidation_refresh");savepoint=false;
          await tx.query("UPDATE analytics_invalidation_queue SET status='completed',processed_at=clock_timestamp(),next_day=NULL WHERE invalidation_id=$1",[id]);
          await tx.query(`INSERT INTO analytics_invalidation_log(invalidation_id,transition,artifact_key)
            VALUES($1,'recomputed',$2)`,[id,token+"|no_existing_snapshots"]);
          await tx.query("COMMIT");counters.completed++;continue;
        }
        const more=dayRows.length>maxDays;
        const days=dayRows.slice(0,maxDays).map(row=>String(row.day));
        if(days.some(day=>!/^\d{4}-\d{2}-\d{2}$/.test(day)))
          throw new Error("invalidation_snapshot_day_invalid");
        const now=(await tx.query("SELECT clock_timestamp() AS at")).rows[0]?.at;
        if(!(now instanceof Date)&&typeof now!=="string")
          throw new Error("invalidation_clock_unavailable");
        for(const day of days)await refresh(tx,canonicalToken.id,day,now);
        await tx.query("RELEASE SAVEPOINT invalidation_refresh");savepoint=false;
        if(more){
          const lastDay=days[days.length-1];
          await tx.query(`UPDATE analytics_invalidation_queue
            SET status='queued',attempts=0,processed_at=NULL,next_attempt_at=clock_timestamp(),
              next_day=$2::date+1 WHERE invalidation_id=$1`,[id,lastDay]);
          await tx.query(`INSERT INTO analytics_invalidation_log(invalidation_id,transition,artifact_key)
            VALUES($1,'queued',$2)`,[id,token+"|through|"+lastDay]);
          await tx.query("COMMIT");counters.continued++;
        }else{
          await tx.query("UPDATE analytics_invalidation_queue SET status='completed',processed_at=clock_timestamp(),next_day=NULL WHERE invalidation_id=$1",[id]);
          await tx.query(`INSERT INTO analytics_invalidation_log(invalidation_id,transition,artifact_key)
            VALUES($1,'recomputed',$2)`,[id,token+"|"+days[0]+".."+days[days.length-1]]);
          await tx.query("COMMIT");counters.completed++;
        }
      }catch{
        if(savepoint){await tx.query("ROLLBACK TO SAVEPOINT invalidation_refresh");savepoint=false;}
        const terminal=Number(item.attempts)+1>=5;
        await tx.query(`UPDATE analytics_invalidation_queue
          SET status=$2,processed_at=CASE WHEN $2='failed' THEN clock_timestamp() ELSE NULL END,
            next_attempt_at=clock_timestamp() +
              (LEAST(300,5*power(2,LEAST(attempts,6))) * INTERVAL '1 second')
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
