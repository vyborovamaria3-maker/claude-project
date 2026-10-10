export type InvestigationTarget = {
  entityId: string;
  objective: string;
};

export type InvestigationResult = {
  entityId: string;
  findings: unknown[];
  confidence: number;
};

export class InvestigationEngine {
  investigate(target: InvestigationTarget): InvestigationResult {
    return {
      entityId: target.entityId,
      findings: [],
      confidence: 0,
    };
  }
}
