export type GraphRankNode = {
  id: string;
  relations?: number;
  evidence?: number;
  activity?: number;
};

export function rankGraphNodes(nodes: GraphRankNode[]) {
  return [...nodes]
    .map((node) => ({
      ...node,
      score: ((node.relations ?? 0) * 0.4) + ((node.evidence ?? 0) * 0.35) + ((node.activity ?? 0) * 0.25),
    }))
    .sort((a, b) => b.score - a.score);
}
