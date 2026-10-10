export type AgentTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface AgentTask {
  id: string;
  type: string;
  priority: number;
  payload: Record<string, unknown>;
  status: AgentTaskStatus;
}

export class IntelligenceAgentWorker {
  async execute(task: AgentTask) {
    return {
      ...task,
      status: 'completed' as AgentTaskStatus,
      executedAt: new Date().toISOString(),
    };
  }
}
