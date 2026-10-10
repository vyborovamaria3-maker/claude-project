export type MemoryEvent = {
  id: string;
  entityId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

export class EpisodicMemory {
  private events: MemoryEvent[] = [];

  remember(event: MemoryEvent) {
    this.events.push(event);
    return event;
  }

  history(entityId: string) {
    return this.events.filter((event) => event.entityId === entityId);
  }
}
