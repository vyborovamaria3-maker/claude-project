export type ScenarioType = 'RISK_CHANGE' | 'RELATION_CHANGE' | 'INFLUENCE_CHANGE';

export interface IntelligenceScenario {
  id: string;
  type: ScenarioType;
  entityId: string;
  assumptions: Record<string, unknown>;
}

export interface ScenarioResult {
  scenarioId: string;
  impactScore: number;
  changes: string[];
}

export function createScenario(input: Omit<IntelligenceScenario, 'id'>): IntelligenceScenario {
  return {
    ...input,
    id: `scenario_${Date.now()}`,
  };
}

export function evaluateScenario(scenario: IntelligenceScenario): ScenarioResult {
  return {
    scenarioId: scenario.id,
    impactScore: 0,
    changes: [],
  };
}
