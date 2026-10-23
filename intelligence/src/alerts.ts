import { parseTokenId, toUtcIso, type TokenId } from "@claude-project/contracts";
import type { PgTransaction } from "./entity-registry.js";


export type AlertSeverity = "info" | "low" | "medium" | "high" | "critical";
export type AlertCandidate = Readonly<{
  canonicalTokenId: TokenId;
  alertType: string;
  severity: AlertSeverity;
  triggeredAt: string;
  asOf: string;
  score: number | null;
  scoreVersion: string;
  features: Record<string, number | string | null>;
  evidenceRefs: readonly string[];
}>;
export type AlertObservation = Readonly<{
  canonicalTokenId: TokenId;
  asOf: Date | string;
  triggeredAt: Date | string;
  maxInputObservedAt: Date | string;
  tgMentions5m?: number | null;
  xMentions5m?: number | null;
  chainVolume1hUsd?: number | null;
  chainVolumeBaseline1hUsd?: number | null;
  tgCopypastaRatio?: number | null;
  xBotRatio?: number | null;
  riskScore?: number | null;
  correlationLift?: number | null;
  correlationPValue?: number | null;
  correlationExposedCount?: number | null;
  correlationControlCount?: number | null;
  correlationValidation?: "out_of_sample";
  scoreVersion: string;
  evidenceRefs: readonly string[];
}>;

function count(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0;
}
function ratio(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1;
}
function finite(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}
function evidenceRefs(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 100 ||
      values.some((value) => typeof value !== "string" || value.length < 1 || value.length > 256)) {
    throw new TypeError("Invalid alert evidence references");
  }
  return [...new Set(values)];
}

export function evaluateCrossPlatformAlerts(input: AlertObservation): AlertCandidate[] {
  if (parseTokenId(input.canonicalTokenId)?.id !== input.canonicalTokenId) throw new TypeError("Noncanonical alert token ID");
  const asOf=toUtcIso(input.asOf);
  const triggeredAt=toUtcIso(input.triggeredAt);
  const maxInputObservedAt=toUtcIso(input.maxInputObservedAt);
  if (maxInputObservedAt>asOf) throw new TypeError("Alert inputs were observed after as_of");
  if (triggeredAt<asOf) throw new TypeError("Alert trigger time cannot precede as_of");
  if (typeof input.scoreVersion!=="string"||!input.scoreVersion.trim()||input.scoreVersion.length>128) {
    throw new TypeError("Invalid alert score version");
  }
  for (const [name,value] of Object.entries({
    tgMentions5m:input.tgMentions5m,xMentions5m:input.xMentions5m,
    correlationExposedCount:input.correlationExposedCount,correlationControlCount:input.correlationControlCount,
  })) {
    if (value!==undefined&&value!==null&&!count(value)) throw new TypeError("Invalid alert count: "+name);
  }
  for (const [name,value] of Object.entries({
    tgCopypastaRatio:input.tgCopypastaRatio,xBotRatio:input.xBotRatio,riskScore:input.riskScore,
    correlationPValue:input.correlationPValue,
  })) {
    if (value!==undefined&&value!==null&&!ratio(value)) throw new TypeError("Invalid alert ratio: "+name);
  }
  for (const [name,value] of Object.entries({
    chainVolume1hUsd:input.chainVolume1hUsd,chainVolumeBaseline1hUsd:input.chainVolumeBaseline1hUsd,
    correlationLift:input.correlationLift,
  })) {
    if (value!==undefined&&value!==null&&!finite(value)) throw new TypeError("Invalid alert metric: "+name);
  }
  const refs=evidenceRefs(input.evidenceRefs);
  const candidates:Array<Omit<AlertCandidate,"canonicalTokenId"|"triggeredAt"|"asOf"|"scoreVersion"|"evidenceRefs">>=[];

  if (count(input.tgMentions5m)&&input.tgMentions5m>=50) {
    candidates.push({alertType:"tg_mentions_spike",severity:"medium",score:input.tgMentions5m,
      features:{tgMentions5m:input.tgMentions5m}});
  }
  if (count(input.xMentions5m)&&input.xMentions5m>=50) {
    candidates.push({alertType:"x_mentions_spike",severity:"medium",score:input.xMentions5m,
      features:{xMentions5m:input.xMentions5m}});
  }
  if (finite(input.chainVolume1hUsd)&&finite(input.chainVolumeBaseline1hUsd)&&
      input.chainVolumeBaseline1hUsd>0&&input.chainVolume1hUsd/input.chainVolumeBaseline1hUsd>=10) {
    candidates.push({alertType:"chain_volume_anomaly",severity:"high",
      score:input.chainVolume1hUsd/input.chainVolumeBaseline1hUsd,
      features:{chainVolume1hUsd:input.chainVolume1hUsd,chainVolumeBaseline1hUsd:input.chainVolumeBaseline1hUsd}});
  }
  if (ratio(input.tgCopypastaRatio)&&input.tgCopypastaRatio>=0.8) {
    candidates.push({alertType:"coordinated_copypasta",severity:"high",score:input.tgCopypastaRatio,
      features:{tgCopypastaRatio:input.tgCopypastaRatio}});
  }
  if (ratio(input.xBotRatio)&&input.xBotRatio>=0.7) {
    candidates.push({alertType:"high_bot_activity",severity:"medium",score:input.xBotRatio,
      features:{xBotRatio:input.xBotRatio}});
  }
  if (ratio(input.riskScore)&&input.riskScore>=0.7) {
    candidates.push({alertType:"rug_risk",severity:"critical",score:input.riskScore,
      features:{riskScore:input.riskScore}});
  }
  // Correlation statistics are exploratory; this code never certifies returns.
  if (finite(input.correlationLift)&&input.correlationLift>=2&&
      ratio(input.correlationPValue)&&input.correlationPValue<=0.05&&
      count(input.correlationExposedCount)&&input.correlationExposedCount>=10&&
      count(input.correlationControlCount)&&input.correlationControlCount>=10&&
      // A caller's out_of_sample flag does NOT authenticate this specific
      // event/outcome. Research alert only until a correlation-specific
      // holdout certificate is persisted and verified.
      true) {
    candidates.push({alertType:"correlation_candidate",severity:"medium",score:input.correlationLift,
      features:{correlationLift:input.correlationLift,correlationPValue:input.correlationPValue,
        correlationExposedCount:input.correlationExposedCount,correlationControlCount:input.correlationControlCount}});
  }
  if (!refs.length) return [];
  return candidates.map((candidate)=>({
    ...candidate,canonicalTokenId:input.canonicalTokenId,triggeredAt,asOf,
    scoreVersion:input.scoreVersion,evidenceRefs:refs,
  }));
}

export async function persistAlertCandidates(
  tx:PgTransaction,candidates:readonly AlertCandidate[],
):Promise<number[]> {
  const created:number[]=[];
  for(const alert of candidates) {
    if(parseTokenId(alert.canonicalTokenId)?.id!==alert.canonicalTokenId)throw new TypeError("Noncanonical alert token ID");
    if(!["info","low","medium","high","critical"].includes(alert.severity))throw new TypeError("Invalid alert severity");
    if(alert.triggeredAt<alert.asOf)throw new TypeError("Alert trigger time cannot precede as_of");
    if(!/^[a-z][a-z0-9_]{0,63}$/.test(alert.alertType))throw new TypeError("Invalid alert type");
    const refs=evidenceRefs(alert.evidenceRefs);
    // Generic score-version validation cannot certify a token-specific event/
    // outcome correlation. Fail closed until scoped independent proof exists.
    if(alert.alertType==="validated_correlation")
      throw new Error("validated_correlation_scoped_evidence_required");
    // Caller must hold a transaction: this lock serializes concurrent evaluators per token/type.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[alert.canonicalTokenId+"|"+alert.alertType]);
    const recent=await tx.query(`SELECT alert_id FROM token_alerts
      WHERE canonical_token_id=$1 AND alert_type=$2 AND status<>'resolved'
      LIMIT 1`,[alert.canonicalTokenId,alert.alertType]);
    if(recent.rows.length)continue;
    const result=await tx.query(`INSERT INTO token_alerts
      (canonical_token_id,alert_type,severity,triggered_at,as_of,score,score_version,features,evidence_refs,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,'open')
      ON CONFLICT(canonical_token_id,alert_type,triggered_at) DO NOTHING
      RETURNING alert_id`,[
      alert.canonicalTokenId,alert.alertType,alert.severity,alert.triggeredAt,alert.asOf,
      alert.score,alert.scoreVersion,JSON.stringify(alert.features),JSON.stringify(refs),
    ]);
    for(const row of result.rows)created.push(Number(row.alert_id));
  }
  return created;
}

export function formatTelegramAlert(alert:Pick<AlertCandidate,"canonicalTokenId"|"alertType"|"severity"|"triggeredAt"|"score"|"scoreVersion"|"evidenceRefs">):string {
  const score=alert.score===null?"n/a":String(Number(alert.score.toFixed(4)));
  const refs=alert.evidenceRefs.slice(0,8).join(", ")||"none";
  return [
    "[POTAPoff] "+alert.severity.toUpperCase()+" "+alert.alertType,
    "Token: "+alert.canonicalTokenId,
    "Score: "+score+" ("+alert.scoreVersion+")",
    "Triggered at: "+alert.triggeredAt,
    "Evidence: "+refs,
  ].join("\n").slice(0,3500);
}
