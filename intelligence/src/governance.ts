import {toUtcIso} from "@claude-project/contracts";
import type {PgTransaction} from "./entity-registry.js";

/**
 * Read-only validation gate. Only completed, independently held-out historical
 * backtests may permit a validated_correlation alert. A caller-supplied flag is
 * not evidence. A failed/missing migration also fails closed.
 */
export async function requireCurrentSignalValidation(
  tx:PgTransaction,signalVersion:string,signalAt:Date|string,
):Promise<boolean> {
  if(typeof signalVersion!=="string"||signalVersion.length<1||signalVersion.length>128)
    throw new TypeError("Invalid signal version");
  const at=toUtcIso(signalAt);
  const result=await tx.query(`SELECT validation.validation_id
    FROM signal_validation_registry validation JOIN backtest_runs run
      ON run.run_id=validation.backtest_run_id
    JOIN signal_policy_preregistrations policy
      ON policy.policy_id=validation.policy_id
    WHERE validation.signal_version=$1 AND validation.validation_status='passed'
      AND validation.method IN ('walk_forward','holdout','expanding_window')
      AND validation.dataset_cutoff=run.data_cutoff_at
      AND run.feature_version=validation.signal_version
      AND run.signal_name=policy.signal_name
      AND run.threshold=policy.threshold AND run.horizon_hours=policy.horizon_hours
      AND policy.signal_version=validation.signal_version
      AND policy.registered_at<(validation.method_params->>'splitAt')::timestamptz
      AND (validation.method_params->>'splitAt')::timestamptz<=validation.dataset_cutoff
      AND validation.method_params->>'producer'='temporal_holdout_v1'
      AND jsonb_typeof(validation.validation_report->'pValue')='number'
      AND jsonb_typeof(validation.validation_report->'lift')='number'
      AND jsonb_typeof(validation.validation_report->'selectedCount')='number'
      AND jsonb_typeof(validation.validation_report->'controlCount')='number'
      AND CASE WHEN jsonb_typeof(validation.validation_report->'pValue')='number'
        THEN (validation.validation_report->>'pValue')::numeric BETWEEN 0 AND 0.05
        ELSE FALSE END
      AND CASE WHEN jsonb_typeof(validation.validation_report->'lift')='number'
        THEN (validation.validation_report->>'lift')::numeric>=2
        ELSE FALSE END
      AND CASE WHEN jsonb_typeof(validation.validation_report->'selectedCount')='number'
        THEN (validation.validation_report->>'selectedCount')::numeric>=10
        ELSE FALSE END
      AND CASE WHEN jsonb_typeof(validation.validation_report->'controlCount')='number'
        THEN (validation.validation_report->>'controlCount')::numeric>=10
        ELSE FALSE END
      AND validation.published_at<=$2::timestamptz
      AND validation.deployment_valid_until>$2::timestamptz
      AND run.status='completed' AND run.completed_at<=$2::timestamptz
      AND run.data_cutoff_at<=$2::timestamptz
      AND (run.metrics->>'sampleSize') ~ '^[0-9]+$'
      AND (run.metrics->>'sampleSize')::bigint>=20
    ORDER BY validation.published_at DESC LIMIT 1`,[signalVersion,at]);
  return result.rows.length>0;
}

export type CostEntry=Readonly<{
  requestId:string;providerId:string;modelId:string;
  task:"sentiment"|"narrative"|"explanation"|"embedding";
  sourceSystem?:"x"|"tg"|null;sourceEventKey?:string|null;
  inputTokens?:number|null;outputTokens?:number|null;
  estimatedCostUsd?:number|null;billedCostUsd?:number|null;
  status?:"completed"|"failed"|"unknown";
}>;

/** Idempotent monetary audit; this records estimation, not provider invoices. */
export async function recordAiCost(tx:PgTransaction,input:CostEntry):Promise<boolean> {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId)||
     !/^[a-zA-Z0-9._-]{1,64}$/.test(input.providerId)||
     !/^[a-zA-Z0-9._-]{1,128}$/.test(input.modelId))throw new TypeError("Invalid cost identity");
  for(const value of [input.inputTokens,input.outputTokens])if(value!==undefined&&value!==null&&
    (!Number.isSafeInteger(value)||value<0))throw new TypeError("Invalid cost token count");
  for(const value of [input.estimatedCostUsd,input.billedCostUsd])if(value!==undefined&&value!==null&&
    (!Number.isFinite(value)||value<0))throw new TypeError("Invalid monetary amount");
  const result=await tx.query(`INSERT INTO ai_cost_ledger
    (request_id,provider_id,model_id,task,source_system,source_event_key,
     input_tokens,output_tokens,estimated_cost_usd,billed_cost_usd,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT(request_id) DO NOTHING RETURNING request_id`,[
      input.requestId,input.providerId,input.modelId,input.task,
      input.sourceSystem??null,input.sourceEventKey??null,input.inputTokens??null,
      input.outputTokens??null,input.estimatedCostUsd??null,input.billedCostUsd??null,
      input.status??"completed",
    ]);
  return result.rows.length>0;
}

/** Enqueue an idempotent invalidation; processing must publish a NEW snapshot. */
export async function queueAnalyticsInvalidation(tx:PgTransaction,input:Readonly<{
  canonicalTokenId:string;sourceSystem:"x"|"tg"|"blockchain"|"derived";
  eventKind:string;eventKey:string;reason:"edit"|"delete"|"link_invalidated"|"backfill"|"model_changed"|"late_outcome";
}>):Promise<boolean> {
  if(!/^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.canonicalTokenId)||
      !input.eventKind||input.eventKind.length>128||!input.eventKey||input.eventKey.length>512)
    throw new TypeError("Invalid invalidation identity");
  const result=await tx.query(`INSERT INTO analytics_invalidation_queue
    (canonical_token_id,source_system,event_kind,event_key,reason)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT(canonical_token_id,source_system,event_kind,event_key,reason)
      DO NOTHING RETURNING invalidation_id`,[
      input.canonicalTokenId,input.sourceSystem,input.eventKind,input.eventKey,input.reason,
    ]);
  if(!result.rows.length)return false;
  await tx.query(`INSERT INTO analytics_invalidation_log(invalidation_id,transition)
    VALUES ($1,'queued')`,[result.rows[0]!.invalidation_id]);
  return true;
}
