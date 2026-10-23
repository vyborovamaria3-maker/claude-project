import {createHash,randomUUID} from "node:crypto";
import {toUtcIso} from "@claude-project/contracts";
import type {PgTransaction} from "./entity-registry.js";

/** Publish the policy BEFORE the first holdout observation is available.
 * PostgreSQL's clock supplies registered_at; callers cannot backdate it. */
export async function preregisterSignalPolicy(tx:PgTransaction,input:Readonly<{
  signalVersion:string;signalName:string;threshold:number;horizonHours:number;codeRevision:string;
}>):Promise<string>{
  if(!/^[a-zA-Z0-9._-]{1,128}$/.test(input.signalVersion)||
     !/^[a-z][a-z0-9_]{0,63}$/.test(input.signalName)||
     !Number.isFinite(input.threshold)||!Number.isSafeInteger(input.horizonHours)||
     input.horizonHours<1||input.horizonHours>720||
     !/^[a-f0-9]{40}$/.test(input.codeRevision))
    throw new TypeError("invalid_signal_policy");
  const id=randomUUID();
  const result=await tx.query(`INSERT INTO signal_policy_preregistrations
    (policy_id,signal_version,signal_name,threshold,horizon_hours,code_revision)
    VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(signal_version,signal_name,threshold,horizon_hours,code_revision)
    DO NOTHING RETURNING policy_id`,[id,input.signalVersion,input.signalName,input.threshold,
      input.horizonHours,input.codeRevision]);
  if(result.rows.length)return String(result.rows[0]!.policy_id);
  const prior=await tx.query(`SELECT policy_id FROM signal_policy_preregistrations
    WHERE signal_version=$1 AND signal_name=$2 AND threshold=$3
      AND horizon_hours=$4 AND code_revision=$5`,[
    input.signalVersion,input.signalName,input.threshold,input.horizonHours,input.codeRevision,
  ]);
  if(prior.rows.length!==1)throw new Error("policy_registration_failed");
  return String(prior.rows[0]!.policy_id);
}

export type HoldoutRow=Readonly<{
  canonicalTokenId:string;signalAt:string;score:number;selected:boolean;outcome:boolean;
  outcomeAt:string;outcomeObservedAt:string;
}>;
function fisher(a:number,b:number,c:number,d:number):number{
  const successes=a+c,total=a+b+c+d,exposed=a+b;
  // Cached log factorials avoid O(n^2) combinations on the 50k-row limit.
  const factorials=new Float64Array(total+1);
  for(let i=2;i<=total;i++)factorials[i]=factorials[i-1]!+Math.log(i);
  const choose=(n:number,k:number)=>k<0||k>n?Number.NEGATIVE_INFINITY:
    factorials[n]!-factorials[k]!-factorials[n-k]!;
  const lo=Math.max(0,successes-(c+d)),hi=Math.min(exposed,successes);
  const denom=choose(total,successes);
  const logP=(x:number)=>choose(exposed,x)+choose(total-exposed,successes-x)-denom;
  const observed=logP(a);
  let p=0;
  for(let x=lo;x<=hi;x++)if(logP(x)<=observed+1e-8)p+=Math.exp(logP(x));
  return Math.min(1,Math.max(0,p));
}
/**
 * A strictly chronological, never-shuffled holdout. Scores and threshold
 * must have been committed BEFORE labels were observed; the validation
 * only evaluates an already completed backtest, never optimizes a threshold.
 */
export function evaluateTemporalHoldout(rows:readonly HoldoutRow[],testFraction=0.3){
  if(!Array.isArray(rows)||rows.length<40||rows.length>50_000||
     !Number.isFinite(testFraction)||testFraction<0.2||testFraction>0.5)
    throw new TypeError("holdout_insufficient_samples");
  const sorted=[...rows].sort((a,b)=>a.signalAt.localeCompare(b.signalAt)||a.canonicalTokenId.localeCompare(b.canonicalTokenId));
  const distinctTokens=new Set<string>();
  for(const r of sorted){
    if(typeof r.canonicalTokenId!=="string"||distinctTokens.has(r.canonicalTokenId)||
       typeof r.score!=="number"||!Number.isFinite(r.score)||
       typeof r.selected!=="boolean"||typeof r.outcome!=="boolean"||
       toUtcIso(r.outcomeAt)<=toUtcIso(r.signalAt)||
       toUtcIso(r.outcomeObservedAt)<toUtcIso(r.outcomeAt))
      throw new TypeError("holdout_invalid_or_dependent_observations");
    distinctTokens.add(r.canonicalTokenId);
  }
  // Never split observations sharing the same calendar day across train/test.
  const boundary=Math.floor(sorted.length*(1-testFraction));
  const splitDay=sorted[boundary]!.signalAt.slice(0,10);
  const train=sorted.filter(r=>r.signalAt.slice(0,10)<splitDay);
  const test=sorted.filter(r=>r.signalAt.slice(0,10)>=splitDay);
  if(train.length<20||test.length<20||
     new Set(train.map(r=>r.signalAt.slice(0,10))).size<2||
     new Set(test.map(r=>r.signalAt.slice(0,10))).size<2)
    throw new TypeError("holdout_chronological_split_unavailable");
  const selected=test.filter(r=>r.selected),control=test.filter(r=>!r.selected);
  if(selected.length<10||control.length<10)
    throw new TypeError("holdout_control_groups_too_small");
  const a=selected.filter(r=>r.outcome).length,c=control.filter(r=>r.outcome).length;
  const selectedRate=a/selected.length,controlRate=c/control.length;
  const pValue=fisher(a,selected.length-a,c,control.length-c);
  const lift=controlRate===0?null:selectedRate/controlRate;
  const passed=pValue<=0.05&&selectedRate>controlRate&&lift!==null&&lift>=2;
  return {passed,pValue,lift,selectedRate,controlRate,trainCount:train.length,
    testCount:test.length,selectedCount:selected.length,controlCount:control.length,
    splitAt:splitDay+"T00:00:00.000Z",rows:sorted};
}

export async function certifyTemporalHoldout(tx:PgTransaction,input:Readonly<{
  runId:string;signalVersion:string;codeRevision:string;deploymentDays?:number;
}>):Promise<{passed:boolean;reproducibilityHash:string;pValue:number;trainCount:number;testCount:number}>{
  if(!/^[0-9a-f-]{36}$/i.test(input.runId)||!/^[a-zA-Z0-9._-]{1,128}$/.test(input.signalVersion)||
     !/^[0-9a-f]{40}$/.test(input.codeRevision))throw new TypeError("invalid_validation_identity");
  const days=input.deploymentDays??14;
  if(!Number.isSafeInteger(days)||days<1||days>30)throw new TypeError("invalid_validation_expiry");
  // A dedicated validation DB role must protect INSERT into the registry.
  const [run,records]=await Promise.all([
    tx.query(`SELECT run_id,signal_name,status,threshold,baseline_kind,feature_version,
      horizon_hours,model_id,metrics,data_cutoff_at,completed_at FROM backtest_runs
      WHERE run_id=$1`,[input.runId]),
    tx.query(`SELECT canonical_token_id,signal_at,score,selected,outcome_label,
      outcome_at,outcome_observed_at FROM backtest_results WHERE run_id=$1
      ORDER BY signal_at,canonical_token_id`,[input.runId]),
  ]);
  const row=run.rows[0];
  if(!row||row.status!=="completed"||row.feature_version!==input.signalVersion||
      row.baseline_kind!=="market_average"||
      !Number.isFinite(Number(row.threshold))||
      Number((row.metrics as Record<string,unknown>|null)?.sampleSize)!==records.rows.length||
      !row.data_cutoff_at||!row.completed_at)
    throw new TypeError("validation_requires_completed_versioned_backtest");
  const signalFields=new Set(["attention_score","credibility_score","risk_score","momentum_score"]);
  if(typeof row.signal_name!=="string"||!signalFields.has(row.signal_name))
    throw new TypeError("validation_unknown_source_signal");
  const coverage=(row.metrics as Record<string,unknown>)?.outcomeCoverage as Record<string,unknown>|undefined;
  if(!coverage||coverage.eligibleCount!==records.rows.length||
     coverage.labeledCount!==records.rows.length||
     coverage.completedHorizonCount!==records.rows.length||
     coverage.missingOutcomeCount!==0||coverage.incompleteHorizonCount!==0)
    throw new TypeError("validation_unverified_outcome_coverage");
  // Source and outcome comparisons stay inside PostgreSQL: timestamp equality
  // would otherwise lose microseconds through JavaScript Date conversions.
  // The score column is selected from the closed allowlist above, not user SQL.
  const sourceProof=await tx.query(`SELECT COUNT(*)::integer AS invalid
    FROM backtest_results r
    WHERE r.run_id=$1
      AND (
        NOT EXISTS (
          SELECT 1 FROM token_daily_cross_platform f
          WHERE f.canonical_token_id=r.canonical_token_id
            AND f.score_version=$2
            AND date_trunc('milliseconds',f.available_at)=date_trunc('milliseconds',r.signal_at)
            AND date_trunc('milliseconds',f.max_input_observed_at)
                  =date_trunc('milliseconds',r.max_input_observed_at)
            AND f.${row.signal_name}=r.score
        )
        OR NOT EXISTS (
          SELECT 1 FROM token_outcomes o
          WHERE o.canonical_token_id=r.canonical_token_id AND o.outcome_kind=$3
            AND date_trunc('milliseconds',o.outcome_at)=date_trunc('milliseconds',r.outcome_at)
            AND date_trunc('milliseconds',o.observed_at)=date_trunc('milliseconds',r.outcome_observed_at)
            AND o.label=r.outcome_label AND o.evidence_ref IS NOT DISTINCT FROM r.evidence_ref
            AND o.observed_at <= $4::timestamptz AND o.created_at <= $4::timestamptz
        )
      )`,[input.runId,input.signalVersion,row.outcome_kind,row.data_cutoff_at]);
  if(sourceProof.rows[0]?.invalid!==0)
    throw new TypeError("validation_requires_verified_source_and_outcome_provenance");
  const cutoff=toUtcIso(row.data_cutoff_at as Date|string);
  const completed=toUtcIso(row.completed_at as Date|string);
  if(cutoff>completed)throw new TypeError("validation_cutoff_after_completion");
  // Never silently turn a missing label into a negative outcome.
  if(records.rows.some(r=>typeof r.outcome_label!=="boolean"||typeof r.selected!=="boolean"||
      r.score===null||r.score===undefined))
    throw new TypeError("validation_requires_explicit_boolean_outcomes");
  const samples=records.rows.map(r=>({
    canonicalTokenId:String(r.canonical_token_id),signalAt:toUtcIso(r.signal_at as Date|string),
    score:Number(r.score),selected:r.selected===true,outcome:r.outcome_label===true,
    outcomeAt:toUtcIso(r.outcome_at as Date|string),
    outcomeObservedAt:toUtcIso(r.outcome_observed_at as Date|string),
  }));
  for(const item of samples){
    if(item.outcomeObservedAt>cutoff||item.signalAt>=item.outcomeObservedAt||
       item.selected!==(item.score>=Number(row.threshold)))
      throw new TypeError("validation_outcomes_or_threshold_not_point_in_time");
  }
  const result=evaluateTemporalHoldout(samples);
  if(result.splitAt>cutoff)throw new TypeError("validation_split_after_data_cutoff");
  const policy=await tx.query(`SELECT policy_id,registered_at
    FROM signal_policy_preregistrations
    WHERE signal_version=$1 AND signal_name=$2 AND threshold=$3
      AND horizon_hours=$4 AND code_revision=$5
      AND registered_at<$6::timestamptz
    ORDER BY registered_at ASC LIMIT 1`,[
      input.signalVersion,row.signal_name,Number(row.threshold),
      Number(row.horizon_hours),input.codeRevision,result.splitAt,
    ]);
  if(!policy.rows.length)throw new TypeError("validation_policy_not_preregistered");
  const policyId=String(policy.rows[0]!.policy_id);
  const params={producer:"temporal_holdout_v1",splitAt:result.splitAt,
    trainCount:result.trainCount,testCount:result.testCount,
    selectedCount:result.selectedCount,controlCount:result.controlCount};
  const reproducibilityHash=createHash("sha256").update(JSON.stringify({
    codeRevision:input.codeRevision,policyId,runId:input.runId,signalVersion:input.signalVersion,
    modelId:row.model_id,signal:row.signal_name,
    threshold:Number(row.threshold),horizonHours:Number(row.horizon_hours),
    datasetCutoff:cutoff,method:"holdout",params,rows:result.rows,
  })).digest("hex");
  const report={pValue:result.pValue,lift:result.lift,
    selectedRate:result.selectedRate,controlRate:result.controlRate,
    selectedCount:result.selectedCount,controlCount:result.controlCount,
    trainCount:result.trainCount,testCount:result.testCount};
  await tx.query(`INSERT INTO signal_validation_registry
      (signal_version,backtest_run_id,method,method_params,reproducibility_hash,
       dataset_cutoff,validation_status,deployment_valid_until,validation_report,policy_id)
      VALUES ($1,$2,'holdout',$3::jsonb,$4,
        (SELECT data_cutoff_at FROM backtest_runs WHERE run_id=$2),
        $5,clock_timestamp()+($6::integer*INTERVAL '1 day'),$7::jsonb,$8)
      ON CONFLICT(signal_version,backtest_run_id,reproducibility_hash) DO NOTHING`,[
    input.signalVersion,input.runId,JSON.stringify(params),reproducibilityHash,
    result.passed?"passed":"failed",days,JSON.stringify(report),policyId,
  ]);
  return {passed:result.passed,reproducibilityHash,pValue:result.pValue,
    trainCount:result.trainCount,testCount:result.testCount};
}
