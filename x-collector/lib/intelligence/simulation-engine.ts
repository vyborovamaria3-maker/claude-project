export type SimulationInput = {
  entityId: string;
  scenario: string;
  horizon?: number;
};

export type SimulationResult = {
  scenario: string;
  confidence: number;
  projections: Record<string, unknown>;
};

export class SimulationEngine {
  simulate(input: SimulationInput): SimulationResult {
    return {
      scenario: input.scenario,
      confidence: 0,
      projections: {},
    };
  }
}
