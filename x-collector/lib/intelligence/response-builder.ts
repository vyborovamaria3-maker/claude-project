export type IntelligenceResponse = {
  status: 'ok' | 'error';
  result: unknown;
  metadata: {
    generatedAt: string;
  };
};

export function buildIntelligenceResponse(result: unknown): IntelligenceResponse {
  return {
    status: 'ok',
    result,
    metadata: {
      generatedAt: new Date().toISOString(),
    },
  };
}
