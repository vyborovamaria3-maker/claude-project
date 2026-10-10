export type CentralityNode = {
  id: string;
  connections: string[];
};

export type WeightedEdge = {
  from: string;
  to: string;
  weight?: number;
};

export type CentralityScore = {
  id: string;
  centrality: number;
};

export function calculateCentrality(nodes: CentralityNode[]): CentralityScore[] {
  return nodes
    .map((node) => ({
      id: node.id,
      centrality: node.connections.length,
    }))
    .sort((a, b) => b.centrality - a.centrality || a.id.localeCompare(b.id));
}

export function calculateWeightedCentrality(nodes: string[], edges: WeightedEdge[]): CentralityScore[] {
  const scores = new Map<string, number>(nodes.map((node) => [node, 0]));
  for (const edge of edges) {
    if (!scores.has(edge.from) || !scores.has(edge.to) || edge.from === edge.to) continue;
    const weight = edge.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    scores.set(edge.from, (scores.get(edge.from) ?? 0) + weight);
    scores.set(edge.to, (scores.get(edge.to) ?? 0) + weight);
  }
  return [...scores]
    .map(([id, centrality]) => ({ id, centrality }))
    .sort((a, b) => b.centrality - a.centrality || a.id.localeCompare(b.id));
}

export type PageRankOptions = {
  damping?: number;
  iterations?: number;
  tolerance?: number;
};

export function pageRank(
  nodes: string[],
  edges: WeightedEdge[],
  options: PageRankOptions = {},
): CentralityScore[] {
  const damping = options.damping ?? 0.85;
  const iterations = options.iterations ?? 50;
  const tolerance = options.tolerance ?? 1e-10;
  if (!(damping > 0 && damping < 1)) throw new Error("damping must be within (0, 1)");
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error("iterations must be a positive integer");

  const sorted = [...new Set(nodes)].sort();
  const outgoing = new Map<string, Array<{ to: string; weight: number }>>(sorted.map((node) => [node, []]));
  const total = new Map<string, number>(sorted.map((node) => [node, 0]));
  for (const edge of edges) {
    if (!outgoing.has(edge.from) || !outgoing.has(edge.to) || edge.from === edge.to) continue;
    const weight = edge.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    outgoing.get(edge.from)!.push({ to: edge.to, weight });
    total.set(edge.from, (total.get(edge.from) ?? 0) + weight);
  }

  if (!sorted.length) return [];
  const scores = new Map<string, number>(sorted.map((node) => [node, 1 / sorted.length]));
  for (let iteration = 0; iteration < iterations; iteration++) {
    const next = new Map<string, number>(sorted.map((node) => [node, (1 - damping) / sorted.length]));
    let dangling = 0;
    for (const node of sorted) {
      const links = outgoing.get(node)!;
      const out = total.get(node) ?? 0;
      if (!links.length || out === 0) {
        dangling += scores.get(node)!;
        continue;
      }
      for (const link of links) {
        next.set(link.to, next.get(link.to)! + damping * scores.get(node)! * (link.weight / out));
      }
    }
    if (dangling > 0) {
      for (const node of sorted) next.set(node, next.get(node)! + damping * dangling / sorted.length);
    }
    let delta = 0;
    for (const node of sorted) delta += Math.abs(next.get(node)! - scores.get(node)!);
    for (const node of sorted) scores.set(node, next.get(node)!);
    if (delta < tolerance) break;
  }

  return [...scores]
    .map(([id, centrality]) => ({ id, centrality }))
    .sort((a, b) => b.centrality - a.centrality || a.id.localeCompare(b.id));
}
