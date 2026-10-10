export type CentralityNode = {
  id: string;
  connections: string[];
};

export function calculateCentrality(nodes: CentralityNode[]) {
  return nodes
    .map((node) => ({
      id: node.id,
      centrality: node.connections.length,
    }))
    .sort((a, b) => b.centrality - a.centrality);
}
