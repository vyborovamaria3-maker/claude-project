import type { IntelligenceTask } from './agent-core';

export class AnalysisPlanner {
  plan(entityId: string): IntelligenceTask[] {
    return [
      { id: crypto.randomUUID(), goal: 'analyze', entityId, priority: 80 },
      { id: crypto.randomUUID(), goal: 'discover', entityId, priority: 70 },
      { id: crypto.randomUUID(), goal: 'validate', entityId, priority: 60 },
    ];
  }
}
