export type GraphPathNode = {
  id: string;
  type: string;
};

export type GraphPath = {
  nodes: GraphPathNode[];
  depth: number;
};

export class GraphQueryEngine {
  async findConnections(sourceId: string, targetId?: string): Promise<GraphPath[]> {
    if (!targetId) {
      return [{ nodes: [{ id: sourceId, type: 'ENTITY' }], depth: 0 }];
    }

    return [
      {
        nodes: [
          { id: sourceId, type: 'ENTITY' },
          { id: targetId, type: 'ENTITY' },
        ],
        depth: 1,
      },
    ];
  }

  async findNeighbors(entityId: string, limit = 50) {
    return {
      entityId,
      limit,
      neighbors: [],
    };
  }
}
