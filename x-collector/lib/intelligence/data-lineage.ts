export type LineageNodeType = 'source' | 'event' | 'entity' | 'relation' | 'inference';

export interface LineageNode {
  id: string;
  type: LineageNodeType;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface LineageEdge {
  from: string;
  to: string;
  operation: string;
}

export interface DataLineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

export function createLineageNode(node: LineageNode): LineageNode {
  return node;
}

export function buildLineage(nodes: LineageNode[], edges: LineageEdge[]): DataLineageGraph {
  return { nodes, edges };
}
