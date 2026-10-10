export type DecisionPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface IntelligenceDecision {
  entityId: string;
  priority: DecisionPriority;
  reasons: string[];
  score: number;
}

export function createDecision(input: {
  entityId: string;
  riskScore?: number;
  influenceScore?: number;
  anomalyScore?: number;
}): IntelligenceDecision {
  const risk = input.riskScore ?? 0;
  const influence = input.influenceScore ?? 0;
  const anomaly = input.anomalyScore ?? 0;
  const score = risk * 0.45 + influence * 0.25 + anomaly * 0.3;

  const reasons: string[] = [];
  if (risk > 0.7) reasons.push('high_risk');
  if (influence > 0.7) reasons.push('high_influence');
  if (anomaly > 0.7) reasons.push('anomaly_detected');

  const priority: DecisionPriority = score > 0.85 ? 'CRITICAL' : score > 0.65 ? 'HIGH' : score > 0.4 ? 'MEDIUM' : 'LOW';

  return { entityId: input.entityId, priority, reasons, score };
}
