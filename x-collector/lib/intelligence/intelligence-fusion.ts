export interface IntelligenceSource {
  domain: string;
  confidence: number;
  data: Record<string, unknown>;
}

export interface FusionResult {
  confidence: number;
  domains: string[];
  merged: Record<string, unknown>;
}

export class IntelligenceFusion {
  merge(sources: IntelligenceSource[]): FusionResult {
    return {
      confidence:
        sources.length === 0
          ? 0
          : sources.reduce((sum, item) => sum + item.confidence, 0) /
            sources.length,
      domains: sources.map((source) => source.domain),
      merged: Object.assign({}, ...sources.map((source) => source.data)),
    };
  }
}
