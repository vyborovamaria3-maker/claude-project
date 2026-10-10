export interface CollaborationEvent {
  from: string;
  to: string;
  type: string;
  data: unknown;
}

export class AgentCollaboration {
  private events: CollaborationEvent[] = [];

  send(event: CollaborationEvent): void {
    this.events.push(event);
  }

  history(): CollaborationEvent[] {
    return [...this.events];
  }
}
