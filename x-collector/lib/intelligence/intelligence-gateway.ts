export type IntelligenceQuery = {
  entityId?: string;
  domain?: string;
  query?: string;
};

export type IntelligenceGatewayResponse = {
  query: IntelligenceQuery;
  sources: string[];
  data: Record<string, unknown>;
};

export class IntelligenceGateway {
  async query(input: IntelligenceQuery): Promise<IntelligenceGatewayResponse> {
    return {
      query: input,
      sources: ['graph', 'memory', 'analytics', 'blockchain'],
      data: {},
    };
  }
}
