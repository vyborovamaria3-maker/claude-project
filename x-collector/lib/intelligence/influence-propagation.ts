export type InfluenceNode = {
  entityId: string;
  influence: number;
  outgoingRelations: number;
};

export type PropagationResult = {
  entityId: string;
  propagatedScore: number;
  influenceLevel: 'LOW' | 'MEDIUM' | 'HIGH';
};

export function propagateInfluence(nodes: InfluenceNode[]): PropagationResult[] {
  return nodes.map((node) => {
    const score = Math.min(
      1,
      node.influence * 0.7 + Math.min(node.outgoingRelations, 100) / 100 * 0.3,
    );

    return {
      entityId: node.entityId,
      propagatedScore: score,
      influenceLevel: score > 0.75 ? 'HIGH' : score > 0.4 ? 'MEDIUM' : 'LOW',
    };
  });
}
