import { parseTokenId, toUtcIso, type TokenId } from "@claude-project/contracts";
import type { PgTransaction } from "./entity-registry.js";

export type CorrelationSample = Readonly<{
  canonicalTokenId: TokenId;
  eventKind: string;
  eventAt: Date | string;
  outcomeKind: string;
  outcomeAt: Date | string;
  exposed: boolean;
  outcome: boolean;
  maxInputObservedAt: Date | string;
  outcomeObservedAt: Date | string;
}>;

export type CorrelationGroupResult = Readonly<{
  eventKind: string;
  outcomeKind: string;
  sampleSize: number;
  exposedCount: number;
  exposedPositive: number;
  controlCount: number;
  controlPositive: number;
  exposedRate: number | null;
  controlRate: number | null;
  lift: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  pValue: number | null;
  baseline: Record<string, unknown>;
  samples: readonly (CorrelationSample & {
    eventAt: string; outcomeAt: string; maxInputObservedAt: string; outcomeObservedAt: string;
  })[];
}>;

function normalCdf(value: number): number {
  const sign=value<0?-1:1;
  const x=Math.abs(value)/Math.sqrt(2);
  const t=1/(1+0.3275911*x);
  const erf=1-(((((1.061405429*t-1.453152027)*t+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x));
  return 0.5*(1+sign*erf);
}
function proportion(positive:number,count:number):number|null{return count?positive/count:null;}
function validateSample(sample:CorrelationSample,evaluatedAt:string) {
  if(parseTokenId(sample.canonicalTokenId)?.id!==sample.canonicalTokenId)throw new TypeError("Noncanonical correlation token ID");
  if(!/^[a-z][a-z0-9_]{0,63}$/.test(sample.eventKind)||!/^[a-z][a-z0-9_]{0,63}$/.test(sample.outcomeKind)) {
    throw new TypeError("Invalid correlation kind");
  }
  if(typeof sample.exposed!=="boolean"||typeof sample.outcome!=="boolean")throw new TypeError("Correlation labels must be boolean");
  const eventAt=toUtcIso(sample.eventAt);
  const outcomeAt=toUtcIso(sample.outcomeAt);
  const maxInputObservedAt=toUtcIso(sample.maxInputObservedAt);
  const outcomeObservedAt=toUtcIso(sample.outcomeObservedAt);
  if(maxInputObservedAt>eventAt)throw new TypeError("Look-ahead bias: correlation features were observed after the event");
  if(outcomeAt<=eventAt)throw new TypeError("Correlation outcome must follow event time");
  if(outcomeObservedAt<outcomeAt||outcomeObservedAt>evaluatedAt)throw new TypeError("Correlation outcome observation time is invalid");
  return {...sample,eventAt,outcomeAt,maxInputObservedAt,outcomeObservedAt};
}

export function calculateEventOutcomeCorrelations(
  samples: readonly CorrelationSample[],
  evaluatedAtInput: Date | string,
): CorrelationGroupResult[] {
  const evaluatedAt=toUtcIso(evaluatedAtInput);
  const groups=new Map<string,Array<ReturnType<typeof validateSample>>>();
  for(const sample of samples) {
    const validated=validateSample(sample,evaluatedAt);
    const key=validated.eventKind+"|"+validated.outcomeKind;
    const group=groups.get(key)??[];
    group.push(validated);
    groups.set(key,group);
  }
  const results:CorrelationGroupResult[]=[];
  for(const group of groups.values()) {
    const first=group[0]!;
    const exposed=group.filter((row)=>row.exposed);
    const control=group.filter((row)=>!row.exposed);
    const exposedPositive=exposed.filter((row)=>row.outcome).length;
    const controlPositive=control.filter((row)=>row.outcome).length;
    const exposedRate=proportion(exposedPositive,exposed.length);
    const controlRate=proportion(controlPositive,control.length);
    const lift=exposedRate===null||controlRate===null||controlRate===0?null:exposedRate/controlRate;
    let ciLow:number|null=null,ciHigh:number|null=null,pValue:number|null=null;
    if(exposedRate!==null&&controlRate!==null) {
      const correctedA=exposedPositive+0.5;
      const correctedB=exposed.length-exposedPositive+0.5;
      const correctedC=controlPositive+0.5;
      const correctedD=control.length-controlPositive+0.5;
      const correctedExposedRate=correctedA/(correctedA+correctedB);
      const correctedControlRate=correctedC/(correctedC+correctedD);
      const logLift=Math.log(correctedExposedRate/correctedControlRate);
      const standardError=Math.sqrt(1/correctedA-1/(correctedA+correctedB)+1/correctedC-1/(correctedC+correctedD));
      ciLow=Math.exp(logLift-1.96*standardError);
      ciHigh=Math.exp(logLift+1.96*standardError);
      const pooled=(exposedPositive+controlPositive)/(exposed.length+control.length);
      const variance=pooled*(1-pooled)*(1/Math.max(1,exposed.length)+1/Math.max(1,control.length));
      if(exposed.length&&control.length) {
        const se=Math.sqrt(Math.max(0,variance));
        pValue=se===0?(exposedRate===controlRate?1:0):
          Math.max(0,Math.min(1,2*(1-normalCdf(Math.abs((exposedRate-controlRate)/se)))));
      }
    }
    results.push({
      eventKind:first.eventKind,outcomeKind:first.outcomeKind,sampleSize:group.length,
      exposedCount:exposed.length,exposedPositive,controlCount:control.length,controlPositive,
      exposedRate,controlRate,lift,ciLow,ciHigh,pValue,
      baseline:{
        method:"two_proportion_z_test",
        controlDefinition:"same event/outcome cohort windows without the event",
        exposedRate,controlRate,
        exposedCount:exposed.length,exposedPositive,
        controlCount:control.length,controlPositive,
        continuityCorrectionForLiftCi:0.5,
      },
      samples:group,
    });
  }
  return results;
}

export async function persistEventOutcomeCorrelations(
  tx:PgTransaction,
  samples:readonly CorrelationSample[],
  input:Readonly<{evaluatedAt:Date|string;dataCutoffAt:Date|string;modelId?:string|null}>,
):Promise<number> {
  const evaluatedAt=toUtcIso(input.evaluatedAt);
  const dataCutoffAt=toUtcIso(input.dataCutoffAt);
  if(dataCutoffAt>evaluatedAt)throw new TypeError("Correlation data cutoff cannot follow evaluation time");
  const normalized=samples.map((sample)=>validateSample(sample,evaluatedAt));
  if(normalized.some((sample)=>sample.outcomeObservedAt>dataCutoffAt||sample.maxInputObservedAt>dataCutoffAt)) {
    throw new TypeError("Correlation data cutoff precedes an input observation");
  }
  const groups=calculateEventOutcomeCorrelations(samples,evaluatedAt);
  let inserted=0;
  for(const group of groups) {
    for(const sample of group.samples) {
      const result=await tx.query(`INSERT INTO token_correlations
        (canonical_token_id,event_kind,event_at,outcome_kind,outcome_at,lift,ci_low,ci_high,p_value,
         baseline,sample_size,model_id,evaluated_at,data_cutoff_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)
        ON CONFLICT DO NOTHING RETURNING correlation_id`,[
        sample.canonicalTokenId,sample.eventKind,sample.eventAt,sample.outcomeKind,sample.outcomeAt,
        group.lift,group.ciLow,group.ciHigh,group.pValue,JSON.stringify(group.baseline),
        group.sampleSize,input.modelId??null,evaluatedAt,dataCutoffAt,
      ]);
      inserted+=result.rows.length;
    }
  }
  return inserted;
}
