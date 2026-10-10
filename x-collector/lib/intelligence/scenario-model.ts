export type ScenarioState = Record<string, unknown>;

export type Scenario = {
  id: string;
  name: string;
  state: ScenarioState;
};

export function createScenario(id: string, name: string, state: ScenarioState): Scenario {
  return { id, name, state };
}
