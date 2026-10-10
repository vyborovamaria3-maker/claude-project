export interface OnchainNode {
  id: string;
  type: 'wallet' | 'transaction' | 'token';
}

export interface OnchainEdge {
  from: string;
  to: string;
  type: string;
}

export interface OnchainGraph {
  nodes: OnchainNode[];
  edges: OnchainEdge[];
}

export function buildOnchainGraph(nodes: OnchainNode[], edges: OnchainEdge[]): OnchainGraph {
  return { nodes, edges };
}
