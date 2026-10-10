export type InvestigationStep = {
  action: string;
  priority: number;
};

export class InvestigationPlanner {
  plan(objective: string): InvestigationStep[] {
    return [
      { action: objective, priority: 1 },
    ];
  }
}
