import type { IntelligenceAgentType } from './agent-registry';

export interface AgentTask {
  type: IntelligenceAgentType;
  payload: unknown;
}

export class AgentCoordinator {
  route(task: AgentTask) {
    return {
      agent: task.type,
      payload: task.payload,
      status: 'queued',
    };
  }
}
