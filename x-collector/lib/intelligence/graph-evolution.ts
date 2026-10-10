export type GraphEvolutionEventType = 'ENTITY_CREATED' | 'ENTITY_UPDATED' | 'RELATION_CREATED' | 'RELATION_REMOVED';

export interface GraphEvolutionEvent {
  id: string;
  type: GraphEvolutionEventType;
  entityId: string;
  timestamp: number;
  payload?: Record<string, unknown>;
}

export class GraphEvolutionEngine {
  private events: GraphEvolutionEvent[] = [];

  record(event: GraphEvolutionEvent) {
    this.events.push(event);
    return event;
  }

  history(entityId: string) {
    return this.events.filter((event) => event.entityId === entityId);
  }

  stateChanges(entityId: string) {
    return this.history(entityId).map((event) => ({
      type: event.type,
      timestamp: event.timestamp,
    }));
  }
}
