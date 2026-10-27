import {createHash} from "node:crypto";
import {AiGatewayError,type AiGateway} from "@claude-project/ai-gateway";
import {toUtcIso} from "@claude-project/contracts";
import type {PgTransaction} from "./entity-registry.js";
import {isLowValueTelegramPost,type AiMessageContext} from "./ai-message-input.js";
import {createAiAnalysisService} from "./ai-analysis.js";
import {recordAiCost} from "./governance.js";

type Client=PgTransaction & {release(discard?:boolean):void};
export type AiPool={connect():Promise<Client>};
export type AiModels={sentiment?:string;narrative?:string;explanation?:string};
const SAFE_GATEWAY_ERRORS=new Set(["ai_provider_network_error","ai_provider_http_error","ai_provider_auth_failed",
  "ai_provider_rate_limited","ai_provider_response_invalid","ai_provider_response_too_large","ai_provider_rate_limit_exhausted",
  "ai_provider_cost_budget_exhausted","ai_provider_capacity_exhausted","ai_request_aborted","ai_provider_request_failed"]);
function analysisErrorCode(error:unknown):string{
  if(error instanceof AiGatewayError&&SAFE_GATEWAY_ERRORS.has(error.code))return error.code;
  if(error instanceof Error&&error.message==="source_revision_unavailable")return error.message;
  if(error instanceof Error&&["AI structured response is invalid","AI sentiment response failed validation",
    "AI sentiment label and score disagree","AI narrative ID failed validation","AI narrative response failed validation",
    "AI evidence references are invalid","AI returned evidence outside the supplied evidence set"].includes(error.message))
    return "ai_output_validation_failed";
  return "ai_analysis_failed";
}

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
      await client.query(`SELECT m.text,GREATEST(m.collected_at,(to_jsonb(m)->>'edited_at')::timestamptz) AS observed_at FROM tg_messages m
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

/** Prefer an explicit reply parent; otherwise use bounded earlier same-source context. */
export async function readCollectorContext(pool:AiPool,source:Source,ref:string,observedAt:Date|string):Promise<AiMessageContext[]> {
  if(source==='x')return (await readTwitterContextState(pool,ref,observedAt)).context;
  const match=/^tg:message:(-?[1-9][0-9]{0,24}):([1-9][0-9]{0,24})$/.exec(ref);
  if(!match)throw new TypeError("Invalid AI context evidence");
  const at=toUtcIso(observedAt),client=await pool.connect();
  try{
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    // JSON lookup also supports legacy schemas without reply metadata. A
    // declared but unavailable parent must never be replaced by its neighbors.
    const rows=await client.query(`SELECT m.message_id,m.text,m.posted_at,GREATEST(m.collected_at,(to_jsonb(m)->>'edited_at')::timestamptz) AS collected_at,
      CASE WHEN (to_jsonb(target)->>'reply_to_message_id') IS NOT NULL THEN 'reply_parent' ELSE 'earlier_neighbour' END AS relation FROM tg_messages m
      JOIN tg_sources s ON s.id=m.source_id
      JOIN tg_messages target ON target.source_id=m.source_id AND target.message_id=$2
      WHERE s.peer_id=$1 AND target.deleted_at IS NULL AND target.collected_at<=$3
        AND GREATEST(target.collected_at,(to_jsonb(target)->>'edited_at')::timestamptz)<=$3
        AND target.posted_at<=$3
        AND m.message_id<target.message_id AND m.posted_at<=target.posted_at
        AND ((to_jsonb(target)->>'reply_to_message_id') IS NULL
          AND m.posted_at>=target.posted_at-INTERVAL '30 minutes'
          OR m.message_id=(to_jsonb(target)->>'reply_to_message_id')::bigint)
        AND m.collected_at<=$3
        AND GREATEST(m.collected_at,(to_jsonb(m)->>'edited_at')::timestamptz)<=$3
        AND m.deleted_at IS NULL AND length(m.text) BETWEEN 1 AND 1200
      ORDER BY m.posted_at DESC,m.message_id DESC LIMIT 12`,[match[1],match[2],at]);
    await client.query("COMMIT");
    return rows.rows.filter(row=>typeof row.text==="string"&&row.text.trim()&&!isLowValueTelegramPost(row.text))
      .slice(0,2).reverse().map(row=>({evidenceRef:`tg:message:${match[1]}:${row.message_id}`,
        text:row.text as string,postedAt:sourceTime(row.posted_at),observedAt:sourceTime(row.collected_at),relation:row.relation as 'reply_parent'|'earlier_neighbour'}));
  }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}
  finally{client.release();}
}

/** Observation-backed links only. A legacy visible link is not proof of a reply. */
export type TwitterContextState={context:AiMessageContext[];contextAvailability:'unknown'|'none'|'available'|'partial'|'unavailable';unavailableContextRefs:string[];hasUnseenMedia?:boolean};
export async function readTwitterContextState(pool:AiPool,ref:string,observedAt:Date|string):Promise<TwitterContextState> {
  const match=/^x:tweet:([1-9][0-9]{0,24})$/.exec(ref);
  if(!match)throw new TypeError('Invalid AI context evidence');
  const at=toUtcIso(observedAt),client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const available=await client.query("SELECT to_regclass('twitter_tweet_observations') AS observations");
    if(!available.rows[0]?.observations){await client.query('COMMIT');return {context:[],contextAvailability:'unknown',unavailableContextRefs:[]};}
    const target=(await client.query(`SELECT o.raw,t.posted_at FROM twitter_tweets t
      JOIN LATERAL (SELECT raw FROM twitter_tweet_observations WHERE tweet_id=t.tweet_id AND observed_at<=$2 ORDER BY observed_at DESC LIMIT 1) o ON true
      WHERE t.tweet_id=$1 AND t.updated_at<=$3 AND t.posted_at<=$3 AND o.raw->>'text'=t.text`,[match[1],at,Date.parse(at)])).rows[0];
    if(!target){await client.query('COMMIT');return {context:[],contextAvailability:'unknown',unavailableContextRefs:[]};}
    const raw=target.raw as Record<string,unknown>,links=new Map<string,AiMessageContext['relation']>();
    if(raw.id!==match[1]){await client.query('COMMIT');return {context:[],contextAvailability:'unknown',unavailableContextRefs:[]};}
    const add=(id:unknown,relation:AiMessageContext['relation'])=>{
      if(typeof id==='string'&&/^[1-9][0-9]{0,24}$/.test(id)&&id!==match[1]&&!links.has(id)&&links.size<18)links.set(id,relation);
    };
    add(raw.replyToPostId,'reply_parent');add(raw.quotedPostId,'quoted_post');
    const metadataKnown=Array.isArray(raw.relatedPostIds)||links.size>0;
    if(Array.isArray(raw.relatedPostIds))for(const id of raw.relatedPostIds.slice(0,16))add(id,'linked_post');
    const context:AiMessageContext[]=[];
    const unavailableContextRefs:string[]=[];
    for(const [id,relation] of links){
      if(context.length===2)break;
      const row=(await client.query(`SELECT raw,observed_at FROM twitter_tweet_observations
        WHERE tweet_id=$1 AND observed_at<=$2 ORDER BY observed_at DESC LIMIT 1`,[id,at])).rows[0];
      const post=row?.raw as Record<string,unknown>|undefined;
      if(!row||!post||post.id!==id||typeof post.text!=='string'||!post.text.trim()||post.text.length>1200||
        typeof post.postedAt!=='number'||!Number.isSafeInteger(post.postedAt)||post.postedAt<0||post.postedAt>Number(target.posted_at)){unavailableContextRefs.push('x:tweet:'+id);continue;}
      context.push({evidenceRef:'x:tweet:'+id,text:post.text,postedAt:sourceTime(post.postedAt),observedAt:sourceTime(row.observed_at),relation});
    }
    await client.query('COMMIT');return {context,unavailableContextRefs,contextAvailability:context.length?(unavailableContextRefs.length?'partial':'available'):(unavailableContextRefs.length?'unavailable':metadataKnown?'none':'unknown'),...(Array.isArray(raw.media)?{hasUnseenMedia:raw.media.length>0}:{})};
  }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}
  finally{client.release();}
}

/** Reserve one bounded sample position for an observed relation, not a sentiment. */
export async function twitterContextCandidates(pool:AiPool,ids:string[],observedAt:string):Promise<Set<string>> {
  if(ids.length>96)throw new RangeError('Too many Twitter context candidates');
  const client=await pool.connect();
  try{
    await client.query('BEGIN READ ONLY');
    const available=await client.query("SELECT to_regclass('twitter_tweet_observations') AS observations");
    if(!available.rows[0]?.observations){await client.query('COMMIT');return new Set();}
    const rows=await client.query(`SELECT t.tweet_id FROM twitter_tweets t
      JOIN LATERAL (SELECT raw FROM twitter_tweet_observations WHERE tweet_id=t.tweet_id AND observed_at<=$2 ORDER BY observed_at DESC LIMIT 1) o ON true
      WHERE t.tweet_id=ANY($1::text[]) AND o.raw->>'text'=t.text AND o.raw->>'id'=t.tweet_id
        AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(jsonb_build_array(o.raw->'replyToPostId',o.raw->'quotedPostId') ||
          CASE WHEN jsonb_typeof(o.raw->'relatedPostIds')='array' THEN o.raw->'relatedPostIds' ELSE '[]'::jsonb END) WITH ORDINALITY link(id,ord)
          JOIN LATERAL (SELECT raw FROM twitter_tweet_observations WHERE tweet_id=link.id AND observed_at<=$2 ORDER BY observed_at DESC LIMIT 1) p ON true
          WHERE link.ord<=18 AND link.id ~ '^[1-9][0-9]{0,24}$' AND link.id<>t.tweet_id AND p.raw->>'id'=link.id
            AND length(p.raw->>'text') BETWEEN 1 AND 1200
            AND CASE WHEN p.raw->>'postedAt' ~ '^[0-9]{1,16}$' THEN (p.raw->>'postedAt')::numeric<=t.posted_at ELSE false END)`,[ids,toUtcIso(observedAt)]);
    await client.query('COMMIT');return new Set(rows.rows.map(row=>String(row.tweet_id)));
  }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{client.release();}
}

/** Runs AFTER normal collector delivery/ACK. AI failure never changes source delivery. */
export async function runAiAnalysisBatch(input:{destination:AiPool;source:Source;readText:(ref:string,at:Date|string,kind?:string,eventKey?:string)=>Promise<string|null>;
  readContext?:(ref:string,at:Date|string)=>Promise<AiMessageContext[]>;
  gateway:AiGateway;models:AiModels;limit?:number;signal?:AbortSignal;refresh?:(token:string,day:string)=>Promise<void>}){
  const limit=input.limit??2;
  if(!Number.isSafeInteger(limit)||limit<1||limit>8)throw new RangeError("AI batch limit must be 1..8");
  const stats={analyzed:0,filtered:0,failed:0,unavailable:0,busy:false,explained:0,refreshed:0,refreshFailed:0};
  const client=await input.destination.connect();
  const lock="intelligence-ai|"+input.source;
  let locked=false,discard=false;
  try{
    locked=(await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",[lock])).rows[0]?.locked===true;
    if(!locked){stats.busy=true;return stats;}
    const service=createAiAnalysisService(client,input.gateway);
    const contexts=new Map<string,AiMessageContext[]>();
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
          const text=await input.readText(ref,row.observed_at as Date,kind,eventKey);
          if(text===null){stats.unavailable++;throw new Error("source_revision_unavailable");}
          if(input.source==="tg"&&isLowValueTelegramPost(text)){
            await client.query(`INSERT INTO ai_message_attempts(source_system,source_event_kind,event_key,task,model_id,attempts,next_attempt_at,error_code)
              VALUES($1,$2,$3,$4,$5,5,clock_timestamp(),'excluded_template_v1') ON CONFLICT(source_system,source_event_kind,event_key,task,model_id) DO UPDATE
              SET attempts=5,error_code=EXCLUDED.error_code,next_attempt_at=EXCLUDED.next_attempt_at`,[input.source,kind,eventKey,task,modelId]);
            stats.filtered++;continue;
          }
          const contextKey=ref+"|"+sourceTime(row.observed_at);
          if(!contexts.has(contextKey))contexts.set(contextKey,input.source==="tg"&&input.readContext?
            await input.readContext(ref,new Date()):[]);
          const context=contexts.get(contextKey)!;
          const contextEvidence=context.map(item=>({evidenceRef:item.evidenceRef,postedAt:item.postedAt,observedAt:item.observedAt,
            textSha256:createHash("sha256").update(item.text).digest("hex")}));
          const output=task==="sentiment"?await service.analyzeSentiment({modelId,text,evidenceRefs:[ref],context}):
            await service.classifyNarrative({modelId,text,evidenceRefs:[ref],context});
          // Provenance belongs to typed columns, never to arbitrary provider JSON.
          const result=task==="sentiment"?{
            label:(output as {label:string}).label,score:(output as {score:number}).score,
            directionAmbiguous:(output as {directionAmbiguous:boolean}).directionAmbiguous,contextEvidence,
            confidence:output.confidence,evidenceRefs:output.evidenceRefs,
          }:{narrativeId:(output as {narrativeId:string|null}).narrativeId,
            keywords:(output as {keywords:string[]}).keywords,contextEvidence,confidence:output.confidence,evidenceRefs:output.evidenceRefs};
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
          await recordAiCost(client,{requestId:output.traceId,providerId:output.providerId,
            modelId,task,sourceSystem:input.source,sourceEventKey:eventKey,
            inputTokens:output.inputTokens,outputTokens:output.outputTokens,
            estimatedCostUsd:output.estimatedCostUsd,status:"completed"});
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
          const code=analysisErrorCode(error);
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
        await service.saveSignalExplanation(output);
        await recordAiCost(client,{requestId:output.traceId,providerId:output.providerId,
          modelId:input.models.explanation,task:"explanation",
          inputTokens:output.inputTokens,outputTokens:output.outputTokens,
          estimatedCostUsd:output.estimatedCostUsd,status:"completed"});
        stats.explained++;
        }catch{
        stats.failed++;
        await client.query(`INSERT INTO ai_explanation_attempts(alert_id,model_id,attempts,next_attempt_at)
          VALUES($1,$2,1,clock_timestamp()+INTERVAL '5 minutes') ON CONFLICT(alert_id,model_id)
          DO UPDATE SET attempts=ai_explanation_attempts.attempts+1,next_attempt_at=clock_timestamp()+INTERVAL '5 minutes'`,
          [alert.alert_id,input.models.explanation]);
        }finally{
          try{await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[alertLock]);}
          catch(error){discard=true;throw error;}
        }
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
    try{if(locked)await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[lock]);}
    catch(error){discard=true;throw error;}
    finally{client.release(discard);}
  }
}
