export type IntelligenceJobType =
  | 'ENTITY_SUMMARY'
  | 'TAG_CLASSIFICATION'
  | 'RELATION_SUGGESTION'
  | 'SIMILARITY_SEARCH'
  | 'CLUSTER_ANALYSIS'
  | 'RISK_ANALYSIS';

export type IntelligenceJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED';

export interface IntelligenceJob {
  id?: number;
  entityId: number;
  jobType: IntelligenceJobType;
  payload: Record<string, unknown>;
}

export interface AIEnrichmentResult {
  summary?: string;
  tags?: Array<{ name: string; confidence: number }>;
  relations?: Array<{ targetEntityId: number; relation: string; confidence: number }>;
  riskScore?: number;
}

/**
 * AI enrichment orchestration layer.
 *
 * This service intentionally keeps model providers separate from storage.
 * Provider adapters can be connected later without changing graph storage.
 */
export class AIEnrichmentPipeline {
  async createJob(input: IntelligenceJob): Promise<IntelligenceJob> {
    return input;
  }

  async process(
    job: IntelligenceJob,
    analyzer: (payload: Record<string, unknown>) => Promise<AIEnrichmentResult>,
  ): Promise<AIEnrichmentResult> {
    return analyzer(job.payload);
  }
}
