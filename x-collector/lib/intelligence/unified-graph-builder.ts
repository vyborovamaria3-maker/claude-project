export type GraphDomain = 'social' | 'knowledge' | 'blockchain';

export interface UnifiedGraphNode {
  id: string;
  domain: GraphDomain;
  type: string;
  metadata?: Record<string, unknown>;
}

export interface UnifiedGraphEdge {
  from: string;
  to: string;
  relation: string;
  confidence: number;
  evidence?: unknown[];
}

export class UnifiedGraphBuilder {
  build(nodes: UnifiedGraphNode[], edges: UnifiedGraphEdge[]) {
    return {
      nodes,
      edges,
      generatedAt: new Date().toISOString(),
    };
  }
}
