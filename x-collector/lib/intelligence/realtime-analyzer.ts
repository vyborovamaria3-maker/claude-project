import type { IntelligenceEvent } from './event-stream';

export interface AnalysisSignal {
  type: string;
  score: number;
  entityId?: string;
}

export function analyzeRealtimeEvent(event: IntelligenceEvent): AnalysisSignal[] {
  const signals: AnalysisSignal[] = [];

  if (event.type === 'RISK_SIGNAL') {
    signals.push({
      type: 'risk_detected',
      score: 0.8,
      entityId: event.entityId,
    });
  }

  if (event.type === 'NEW_EVIDENCE') {
    signals.push({
      type: 'evidence_update',
      score: 0.5,
      entityId: event.entityId,
    });
  }

  return signals;
}
