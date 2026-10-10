export interface AgentTask {
  id: string;
  type: string;
  payload: unknown;
  priority: number;
}

export interface AgentRuntimeState {
  running: boolean;
  processed: number;
}

export class AgentRuntime {
  private state: AgentRuntimeState = { running: false, processed: 0 };

  start() {
    this.state.running = true;
  }

  stop() {
    this.state.running = false;
  }

  execute(task: AgentTask) {
    if (!this.state.running) throw new Error('agent_runtime_stopped');
    this.state.processed += 1;
    return { taskId: task.id, status: 'completed' };
  }

  getState() {
    return this.state;
  }
}
