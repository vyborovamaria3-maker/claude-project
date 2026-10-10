export interface CommunityNode {
  entityId: string;
  connections: string[];
  score: number;
}

export interface CommunityCluster {
  id: string;
  members: string[];
  score: number;
}

export class CommunityEngine {
  detect(nodes: CommunityNode[]): CommunityCluster[] {
    const clusters = new Map<string, string[]>();

    for (const node of nodes) {
      const key = node.connections.length > 0 ? 'connected' : 'isolated';
      const members = clusters.get(key) ?? [];
      members.push(node.entityId);
      clusters.set(key, members);
    }

    return Array.from(clusters.entries()).map(([id, members]) => ({
      id,
      members,
      score: members.length / Math.max(nodes.length, 1)
    }));
  }
}
