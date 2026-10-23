import {createHash} from "node:crypto";
import type {AiGateway} from "@claude-project/ai-gateway";
import {toUtcIso} from "@claude-project/contracts";
import type {PgTransaction} from "./entity-registry.js";
import {createAiAnalysisService} from "./ai-analysis.js";

type Client=PgTransaction & {release():void};
export type AiPool={connect():Promise<Client>};
export type AiModels={sentiment?:string;narrative?:string;explanation?:string};
type Source="x"|"tg";
function sourceTime(value:unknown):string{
  if(typeof value==="number"||typeof value==="string"&&/^\d{10,16}$/.test(value)){
    const ms=Number(value);if(!Number.isSafeInteger(ms))throw new TypeError("Invalid source timestamp");
    return toUtcIso(new Date(ms));
  }
  if(value instanceof Date||typeof value==="string")return toUtcIso(value);
  throw new TypeError("Invalid source timestamp");
}

/** Exact, read-only lookup: never classify a newer edit under an old inbox revision. */
export async function readCollectorMessage(pool:AiPool,source:Source,ref:string,observedAt:Date|string):Promise<string|null>{
  const match=(source==="x"?/^x:tweet:([1-9][0-9]{0,24})$/:/^tg:message:(-?[1-9][0-9]{0,24}):([1-9][0-9]{0,24})$/).exec(ref);
  if(!match)throw new TypeError("Invalid AI source evidence");
  const client=await pool.connect();
  try{
    await client.query("BEGIN READ ONLY");
    const response=source==="x"?await client.query(`SELECT text,updated_at AS observed_at FROM twitter_tweets WHERE tweet_id=$1`,[match[1]]):
      await client.query(`SELECT m.text,m.collected_at AS observed_at FROM tg_messages m
        JOIN tg_sources s ON s.id=m.source_id
        WHERE s.peer_id=$1 AND m.message_id=$2 AND m.deleted_at IS NULL`,[match[1],match[2]]);
    const row=response.rows[0];
    await client.query("COMMIT");
    if(!row||typeof row.text!=="string"||!row.text.trim()||row.text.length>20_000)return null;
    if(sourceTime(row.observed_at)>toUtcIso(observedAt))return null;
    return row.text;
  }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}
  finally{client.release();}
}

/** Runs AFTER normal collector delivery/ACK. AI failure never changes source delivery. */
export async function runAiAnalysisBatch(input:{destination:AiPool;source:Source;readText:(ref:string,at:Date|string)=>Promise<string|null>;
  gateway:AiGateway;models:AiModels;limit?:number;signal?:AbortSignal;refresh?:(token:string,day:string)=>Promise<void>}){
  const limit=input.limit??2;
  if(!Number.isSafeInteger(limit)||limit<1||limit>8)throw new RangeError("AI batch limit must be 1..8");
  const stats={analyzed:0,failed:0,unavailable:0,busy:false,explained:0,refreshed:0,refreshFailed:0};
  const client=await input.destination.connect();
  const lock="intelligence-ai|"+input.source;
  let locked=false;
  try{
    locked=(await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",[lock])).rows[0]?.locked===true;
    if(!locked){stats.busy=true;return stats;}
    const service=createAiAnalysisService(client,input.gateway);
    for(const task of ["sentiment","narrative"] as const){
      const modelId=input.models[task];if(!modelId)continue;
      if(input.signal?.aborted)break;
      const pending=await client.query(`WITH latest AS (
        SELECT DISTINCT ON(t.evidence_source_id) t.* FROM timeline_events t
        JOIN intelligence_inbox i ON i.source_system=t.source_system AND i.event_kind=t.source_event_kind AND i.event_key=t.event_key
        WHERE t.source_system=$1 AND t.timeline_kind IN ('tweet_published','tg_message_published')
          AND t.observed_at<=clock_timestamp() AND i.ingested_at<=clock_timestamp()
        ORDER BY t.evidence_source_id,t.observed_at DESC,t.event_key DESC
      ) SELECT t.* FROM latest t WHERE NOT EXISTS (
        SELECT 1 FROM ai_message_analyses a WHERE a.source_system=t.source_system
          AND a.source_event_kind=t.source_event_kind AND a.event_key=t.event_key AND a.task=$2 AND a.model_id=$3)
        AND NOT EXISTS(SELECT 1 FROM ai_message_attempts a WHERE a.source_system=t.source_system
          AND a.source_event_kind=t.source_event_kind AND a.event_key=t.event_key AND a.task=$2 AND a.model_id=$3
          AND (a.attempts>=5 OR a.next_attempt_at>clock_timestamp()))
      ORDER BY t.observed_at DESC,t.event_key LIMIT $4`,[input.source,task,modelId,limit]);
      for(const row of pending.rows){
        if(input.signal?.aborted)break;
        const eventKey=String(row.event_key),kind=String(row.source_event_kind),ref=String(row.evidence_source_id);
        try{
          const text=await input.readText(ref,row.observed_at as Date);
          if(text===null){stats.unavailable++;throw new Error("source_revision_unavailable");}
          const output=task==="sentiment"?await service.analyzeSentiment({modelId,text,evidenceRefs:[ref]}):
            await service.classifyNarrative({modelId,text,evidenceRefs:[ref]});
          // Provenance belongs to typed columns, never to arbitrary provider JSON.
          const result=task==="sentiment"?{
            label:(output as {label:string}).label,score:(output as {score:number}).score,
            directionAmbiguous:(output as {directionAmbiguous:boolean}).directionAmbiguous,
            confidence:output.confidence,evidenceRefs:output.evidenceRefs,
          }:{narrativeId:(output as {narrativeId:string|null}).narrativeId,
            keywords:(output as {keywords:string[]}).keywords,confidence:output.confidence,evidenceRefs:output.evidenceRefs};
          await client.query("BEGIN");
          const tokens=await client.query(`SELECT canonical_id FROM timeline_event_entities WHERE source_system=$1
            AND source_event_kind=$2 AND event_key=$3 AND kind='token'
            UNION SELECT v.canonical_token_id FROM token_link_observations v WHERE v.source_system=$1
              AND v.evidence_source_id=$4 AND v.state='verified' AND v.observed_at<=clock_timestamp()
              AND v.inserted_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM token_link_observations inv
                WHERE inv.source_system=v.source_system AND inv.evidence_source_id=v.evidence_source_id
                  AND inv.state='invalidated' AND inv.observed_at>=v.observed_at
                  AND inv.observed_at<=clock_timestamp() AND inv.inserted_at<=clock_timestamp())`,[input.source,kind,eventKey,ref]);
          await client.query(`INSERT INTO ai_message_analyses
            (source_system,source_event_kind,event_key,evidence_ref,canonical_token_ids,text_sha256,task,model_id,
             model_version,provider_id,trace_id,result,source_observed_at)
            VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
            ON CONFLICT DO NOTHING`,[input.source,kind,eventKey,ref,
            JSON.stringify(tokens.rows.map(t=>t.canonical_id)),createHash("sha256").update(text).digest("hex"),task,
            modelId,output.modelVersion,output.providerId,output.traceId,JSON.stringify(result),row.observed_at]);
          await client.query(`DELETE FROM ai_message_attempts WHERE source_system=$1 AND source_event_kind=$2 AND event_key=$3 AND task=$4 AND model_id=$5`,
            [input.source,kind,eventKey,task,modelId]);
          for(const token of tokens.rows)await client.query(`INSERT INTO ai_refresh_pending(canonical_token_id,day)
            VALUES($1,$2::date) ON CONFLICT(canonical_token_id,day) DO UPDATE SET
            revision=ai_refresh_pending.revision+1,attempts=0,next_attempt_at=clock_timestamp()`,
            [token.canonical_id,toUtcIso(row.occurred_at as Date).slice(0,10)]);
          await client.query("COMMIT");stats.analyzed++;
        }catch(error){
          try{await client.query("ROLLBACK");}catch{}
          stats.failed++;
          const code=error instanceof Error&&error.message==="source_revision_unavailable"?error.message:"ai_analysis_failed";
          await client.query(`INSERT INTO ai_message_attempts(source_system,source_event_kind,event_key,task,model_id,attempts,next_attempt_at,error_code)
            VALUES($1,$2,$3,$4,$5,1,clock_timestamp()+INTERVAL '5 minutes',$6)
            ON CONFLICT(source_system,source_event_kind,event_key,task,model_id) DO UPDATE
            SET attempts=ai_message_attempts.attempts+1,next_attempt_at=clock_timestamp()+INTERVAL '5 minutes',error_code=EXCLUDED.error_code`,
            [input.source,kind,eventKey,task,modelId,code]);
        }
      }
    }
    if(input.models.explanation&&!input.signal?.aborted){
      const alerts=await client.query(`SELECT a.alert_id FROM token_alerts a WHERE a.status<>'resolved'
        AND a.triggered_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM signal_explanations e
          WHERE e.alert_id=a.alert_id AND e.model_id=$1)
        AND NOT EXISTS(SELECT 1 FROM ai_explanation_attempts retry WHERE retry.alert_id=a.alert_id
          AND retry.model_id=$1 AND (retry.attempts>=5 OR retry.next_attempt_at>clock_timestamp()))
        ORDER BY a.triggered_at DESC LIMIT $2`,[input.models.explanation,limit]);
      for(const alert of alerts.rows)try{
        if(input.signal?.aborted)break;
        const alertLock="intelligence-ai-alert|"+String(alert.alert_id);
        const claimed=(await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",[alertLock])).rows[0]?.locked===true;
        if(!claimed)continue;
        try{
        // Another source worker may have completed it while we waited for this session lock.
        const existing=await client.query(`SELECT 1 FROM signal_explanations WHERE alert_id=$1 AND model_id=$2
          UNION ALL SELECT 1 FROM ai_explanation_attempts WHERE alert_id=$1 AND model_id=$2
          AND (attempts>=5 OR next_attempt_at>clock_timestamp())`,[alert.alert_id,input.models.explanation]);
        if(existing.rows.length)continue;
        const refs=await client.query("SELECT evidence_refs FROM token_alerts WHERE alert_id=$1",[alert.alert_id]);
        const output=await service.explainSignal({modelId:input.models.explanation,alertId:Number(alert.alert_id),facts:{},
          evidenceRefs:refs.rows[0]?.evidence_refs as string[]});
        await service.saveSignalExplanation(output);stats.explained++;
        }catch{
        stats.failed++;
        await client.query(`INSERT INTO ai_explanation_attempts(alert_id,model_id,attempts,next_attempt_at)
          VALUES($1,$2,1,clock_timestamp()+INTERVAL '5 minutes') ON CONFLICT(alert_id,model_id)
          DO UPDATE SET attempts=ai_explanation_attempts.attempts+1,next_attempt_at=clock_timestamp()+INTERVAL '5 minutes'`,
          [alert.alert_id,input.models.explanation]);
        }finally{await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[alertLock]);}
      }catch{stats.failed++;}
    }
    if(input.refresh&&!input.signal?.aborted){
      const pending=await client.query(`SELECT canonical_token_id,day::text,revision FROM ai_refresh_pending
        WHERE attempts<5 AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at LIMIT $1`,[limit]);
      for(const row of pending.rows)try{
        await input.refresh(String(row.canonical_token_id),String(row.day));
        await client.query("DELETE FROM ai_refresh_pending WHERE canonical_token_id=$1 AND day=$2::date AND revision=$3",[row.canonical_token_id,row.day,row.revision]);
        stats.refreshed++;
      }catch{
        stats.refreshFailed++;
        await client.query(`UPDATE ai_refresh_pending SET attempts=attempts+1,next_attempt_at=clock_timestamp()+INTERVAL '5 minutes'
          WHERE canonical_token_id=$1 AND day=$2::date AND revision=$3`,[row.canonical_token_id,row.day,row.revision]);
      }
    }
    return stats;
  }finally{
    if(locked)await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[lock]);
    client.release();
  }
}
