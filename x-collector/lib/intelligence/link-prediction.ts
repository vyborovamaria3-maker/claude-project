export type PredictionMethod = "common-neighbours" | "adamic-adar" | "preferential-attachment";

export const PREDICTION_METHODS: readonly PredictionMethod[] = [
  "common-neighbours",
  "adamic-adar",
  "preferential-attachment",
];

export type LinkPrediction = {
  from: string;
  to: string;
  score: number;
  method: PredictionMethod;
  evidence: string[];
};

export type PredictionOptions = {
  methods?: readonly PredictionMethod[];
  limit?: number;
  minScore?: number;
};

function assertMethod(method: string): PredictionMethod {
  if (!(PREDICTION_METHODS as readonly string[]).includes(method)) {
    throw new Error(`Unsupported prediction method ${JSON.stringify(method)}`);
  }
  return method as PredictionMethod;
}

function adjacencyOf(nodes: string[], edges: Array<{ source: string; target: string }>): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const known = new Set(nodes);
  for (const node of nodes) adjacency.set(node, new Set());
  for (const edge of edges) {
    if (!known.has(edge.source) || !known.has(edge.target) || edge.source === edge.target) continue;
    adjacency.get(edge.source)!.add(edge.target);
    adjacency.get(edge.target)!.add(edge.source);
  }
  return adjacency;
}

function scoreOf(
  method: PredictionMethod,
  left: Set<string>,
  right: Set<string>,
  degrees: Map<string, number>,
): { score: number; evidence: string[] } {
  const shared = [...left].filter((node) => right.has(node)).sort();
  if (method === "common-neighbours") {
    const score = shared.length / Math.sqrt(left.size * right.size || 1);
    return { score, evidence: shared };
  }
  if (method === "adamic-adar") {
    let score = 0;
    for (const node of shared) {
      const degree = degrees.get(node) ?? 0;
      if (degree > 1) score += 1 / Math.log(degree);
    }
    return { score, evidence: shared };
  }
  return { score: left.size * right.size, evidence: [] };
}

export function predictLinks(
  nodes: string[],
  edges: Array<{ source: string; target: string }>,
  options: PredictionOptions = {},
): LinkPrediction[] {
  const methods = (options.methods ?? PREDICTION_METHODS).map(assertMethod);
  const limit = options.limit ?? 100;
  const minScore = options.minScore ?? 0;
  if (!Number.isInteger(limit) || limit < 0) throw new Error("limit must be a non-negative integer");
  if (!Number.isFinite(minScore) || minScore < 0) throw new Error("minScore must be a non-negative number");

  const adjacency = adjacencyOf(nodes, edges);
  const degrees = new Map([...adjacency].map(([node, neighbours]) => [node, neighbours.size]));
  const sortedNodes = [...adjacency.keys()].sort();
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < sortedNodes.length; i++) {
    for (let j = i + 1; j < sortedNodes.length; j++) {
      const left = sortedNodes[i];
      const right = sortedNodes[j];
      if (adjacency.get(left)!.has(right)) continue;
      if (degrees.get(left) === 0 || degrees.get(right) === 0) continue;
      pairs.push([left, right]);
    }
  }

  const predictions: LinkPrediction[] = [];
  for (const method of methods) {
    const scored = pairs.map(([from, to]) => {
      const { score, evidence } = scoreOf(method, adjacency.get(from)!, adjacency.get(to)!, degrees);
      return { from, to, score, method, evidence };
    });
    scored.sort(
      (a, b) => b.score - a.score || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
    );
    predictions.push(...scored.filter((entry) => entry.score >= minScore).slice(0, limit));
  }
  return predictions;
}
