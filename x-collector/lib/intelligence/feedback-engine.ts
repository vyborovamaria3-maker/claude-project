export type FeedbackEvent = {
  entityId: string;
  accepted: boolean;
  reason?: string;
};

export class FeedbackEngine {
  private events: FeedbackEvent[] = [];

  add(event: FeedbackEvent) {
    this.events.push(event);
    return event;
  }

  get(entityId: string) {
    return this.events.filter((e) => e.entityId === entityId);
  }
}
