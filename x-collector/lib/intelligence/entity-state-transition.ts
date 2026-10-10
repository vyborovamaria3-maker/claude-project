export interface EntityStateTransition {
  entityId: string;
  from: string;
  to: string;
  reason?: string;
  timestamp: number;
}

export class EntityStateMachine {
  private transitions: EntityStateTransition[] = [];

  transition(change: EntityStateTransition) {
    this.transitions.push(change);
    return change;
  }

  getTransitions(entityId: string) {
    return this.transitions.filter((item) => item.entityId === entityId);
  }
}
