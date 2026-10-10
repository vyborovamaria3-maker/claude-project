export type InfluenceNode = {
  entityId: string;
  influence: number;
  outgoingRelations: number;
};

export function propagateInfluence(nodes: InfluenceNode[]) {
  return nodes.map((node) => ({
    entityId: node.entityId,
    propagatedScore: Math.min(1, node.influence * 0.7 + Math.min(node.outgoingRelations, 100) / 100 * 0.3)
  }));
}
