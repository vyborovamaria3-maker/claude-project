export type AgentGoal = 'analyze' | 'discover' | 'enrich' | 'validate';

export interface IntelligenceTask {
  id: string;
  goal: AgentGoal;
  entityId?: string;
  priority: number;
  metadata?: Record<string, unknown>;
}

export class IntelligenceAgent {
  createTask(input: Omit<IntelligenceTask, 'id'>): IntelligenceTask {
    return { ...input, id: crypto.randomUUID() };
  }

  evaluate(task: IntelligenceTask) {
    return { task, status: 'planned', nextAction: task.goal };
  }
}
