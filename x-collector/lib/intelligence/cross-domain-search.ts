import type { GraphDomain, UnifiedGraphNode } from './unified-graph-builder';

export interface SearchResult {
  node: UnifiedGraphNode;
  matchedDomains: GraphDomain[];
  confidence: number;
}

export class CrossDomainSearch {
  search(nodes: UnifiedGraphNode[], query: string): SearchResult[] {
    const normalized = query.toLowerCase();

    return nodes
      .filter((node) => JSON.stringify(node).toLowerCase().includes(normalized))
      .map((node) => ({
        node,
        matchedDomains: [node.domain],
        confidence: 0.5,
      }));
  }
}
