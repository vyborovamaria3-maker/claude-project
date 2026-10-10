export type WorkflowState = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export class WorkflowStateMachine {
  private state: WorkflowState = 'PENDING';

  getState(): WorkflowState {
    return this.state;
  }

  transition(next: WorkflowState): WorkflowState {
    this.state = next;
    return this.state;
  }
}
