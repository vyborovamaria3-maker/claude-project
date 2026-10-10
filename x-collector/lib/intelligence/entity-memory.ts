export interface EntityMemoryEvent {
  entityId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export class EntityMemoryStore {
  private events: EntityMemoryEvent[] = [];

  add(event: EntityMemoryEvent) {
    this.events.push(event);
    return event;
  }

  history(entityId: string) {
    return this.events.filter((event) => event.entityId === entityId);
  }
}
