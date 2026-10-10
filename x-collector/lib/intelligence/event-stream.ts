export type IntelligenceEventType =
  | 'ENTITY_UPDATED'
  | 'RELATION_CREATED'
  | 'RISK_SIGNAL'
  | 'NEW_EVIDENCE';

export interface IntelligenceEvent {
  id: string;
  type: IntelligenceEventType;
  entityId?: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export class IntelligenceEventStream {
  private listeners: Array<(event: IntelligenceEvent) => void> = [];

  subscribe(listener: (event: IntelligenceEvent) => void) {
    this.listeners.push(listener);
  }

  publish(event: IntelligenceEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
