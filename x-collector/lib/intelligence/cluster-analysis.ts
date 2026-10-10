export type ClusterScore = {
  clusterId: string;
  size: number;
  connectivity: number;
};

export function analyzeCluster(clusterId: string, members: string[], edges: number): ClusterScore {
  return {
    clusterId,
    size: members.length,
    connectivity: members.length ? edges / members.length : 0,
  };
}
