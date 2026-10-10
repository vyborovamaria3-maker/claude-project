export interface AgentLoad {
  agentId: string;
  activeTasks: number;
}

export class AgentLoadBalancer {
  selectAgent(agents: AgentLoad[]): string | undefined {
    return [...agents].sort((a, b) => a.activeTasks - b.activeTasks)[0]?.agentId;
  }
}
