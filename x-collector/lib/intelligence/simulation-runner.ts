import { IntelligenceScenario, ScenarioResult, evaluateScenario } from './scenario-engine';

export interface SimulationRun {
  startedAt: number;
  results: ScenarioResult[];
}

export function runSimulation(scenarios: IntelligenceScenario[]): SimulationRun {
  return {
    startedAt: Date.now(),
    results: scenarios.map(evaluateScenario),
  };
}
