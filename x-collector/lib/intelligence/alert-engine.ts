export type IntelligenceAlertType =
  | 'RISK_SPIKE'
  | 'INFLUENCE_CHANGE'
  | 'NEW_RELATION'
  | 'ANOMALY_DETECTED';

export interface IntelligenceAlert {
  type: IntelligenceAlertType;
  entityId: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  metadata?: Record<string, unknown>;
}

export class AlertEngine {
  createAlert(alert: IntelligenceAlert) {
    return {
      ...alert,
      createdAt: new Date().toISOString(),
    };
  }
}

export type AlertSweepResult = {
  sweptAt: string;
  alerts: Array<IntelligenceAlert & { createdAt: string }>;
};

export async function processAlerts(candidates: IntelligenceAlert[] = []): Promise<AlertSweepResult> {
  const engine = new AlertEngine();
  return {
    sweptAt: new Date().toISOString(),
    alerts: candidates.map((alert) => engine.createAlert(alert)),
  };
}
