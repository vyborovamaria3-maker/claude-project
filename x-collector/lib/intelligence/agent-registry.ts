export type IntelligenceAgentType =
  | 'graph'
  | 'blockchain'
  | 'risk'
  | 'research';

export interface IntelligenceAgent {
  id: string;
  type: IntelligenceAgentType;
  enabled: boolean;
}

export class AgentRegistry {
  private agents = new Map<string, IntelligenceAgent>();

  register(agent: IntelligenceAgent) {
    this.agents.set(agent.id, agent);
  }

  get(id: string) {
    return this.agents.get(id);
  }

  list() {
    return [...this.agents.values()];
  }
}
