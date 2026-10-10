export type EnrichmentTaskType =
  | 'ENTITY_REFRESH'
  | 'TAG_REFRESH'
  | 'RELATION_DISCOVERY'
  | 'SCORE_RECALCULATION'
  | 'RISK_ANALYSIS';

export interface EnrichmentTask {
  type: EnrichmentTaskType;
  entityId: string;
  payload?: Record<string, unknown>;
}

export class AutoEnrichmentWorker {
  async process(task: EnrichmentTask) {
    return {
      status: 'queued',
      task,
      processedAt: new Date().toISOString(),
    };
  }
}

export async function refreshIntelligenceProfiles(
  tasks: EnrichmentTask[] = [],
  worker = new AutoEnrichmentWorker(),
) {
  return Promise.all(tasks.map((task) => worker.process(task)));
}
