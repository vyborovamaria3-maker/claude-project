export type GraphSearchNode = {
  id: string;
  type: string;
  label?: string;
};

export type GraphSearchResult = {
  nodes: GraphSearchNode[];
  score: number;
};

export function searchGraph(nodes: GraphSearchNode[], query: string): GraphSearchResult[] {
  const normalized = query.toLowerCase();

  return nodes
    .filter((node) => `${node.id} ${node.label ?? ''}`.toLowerCase().includes(normalized))
    .map((node) => ({ nodes: [node], score: 1 }));
}
