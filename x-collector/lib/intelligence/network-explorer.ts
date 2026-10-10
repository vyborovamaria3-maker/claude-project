export type NetworkNode = {
  id: string;
  label?: string;
  type: string;
};

export type NetworkResult = {
  nodes: NetworkNode[];
  edges: Array<{
    source: string;
    target: string;
    relation?: string;
  }>;
};

export class NetworkExplorer {
  async explore(entityId: string, _depth = 2): Promise<NetworkResult> {
    return {
      nodes: [{ id: entityId, type: 'ENTITY' }],
      edges: [],
    };
  }
}
