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
