export interface AgentMessage {
  agentId: string;
  taskId: string;
  payload: unknown;
}

export class SwarmCoordinator {
  private messages: AgentMessage[] = [];

  publish(message: AgentMessage): void {
    this.messages.push(message);
  }

  drain(): AgentMessage[] {
    const result = [...this.messages];
    this.messages = [];
    return result;
  }
}
