import type { PoolClient } from "pg";
import { putEmbedding } from "../trade/intelligence-blockchain";

type Client = Pick<PoolClient, "query">;

export type EmbeddingAlgorithm = "random-walk" | "spectral";

export const EMBEDDING_ALGORITHMS: readonly EmbeddingAlgorithm[] = ["random-walk", "spectral"];

export const EMBEDDING_VERSION = "1";

export const MAX_EMBEDDING_DIMENSIONS = 4096;

export const MAX_EMBEDDING_NODES = 512;

export type GraphEdge = {
  source: string;
  target: string;
  weight?: number;
};

export type EmbeddingOptions = {
  algorithm?: EmbeddingAlgorithm;
  dimensions?: number;
  seed?: number;
  walks?: number;
  steps?: number;
  limit?: number;
};

export type GraphEmbedding = {
  model: string;
  algorithm: EmbeddingAlgorithm;
  dimensions: number;
  nodes: string[];
  vectors: number[][];
};

export function modelId(algorithm: EmbeddingAlgorithm, version = EMBEDDING_VERSION): string {
  return `${algorithm}@${version}`;
}

function assertDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_EMBEDDING_DIMENSIONS) {
    throw new Error(`Embedding dimensions must be an integer in [1, ${MAX_EMBEDDING_DIMENSIONS}]`);
  }
}

function assertAlgorithm(algorithm: string): EmbeddingAlgorithm {
  if (!(EMBEDDING_ALGORITHMS as readonly string[]).includes(algorithm)) {
    throw new Error(`Unsupported embedding algorithm ${JSON.stringify(algorithm)}`);
  }
  return algorithm as EmbeddingAlgorithm;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildAdjacency(
  nodes: string[],
  edges: GraphEdge[],
): { nodes: string[]; weights: number[][] } {
  const sorted = [...new Set(nodes)].sort();
  const index = new Map(sorted.map((node, position) => [node, position]));
  const weights = sorted.map(() => sorted.map(() => 0));
  for (const edge of edges) {
    const from = index.get(edge.source);
    const to = index.get(edge.target);
    if (from === undefined || to === undefined || from === to) continue;
    const weight = edge.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    weights[from][to] += weight;
    weights[to][from] += weight;
  }
  return { nodes: sorted, weights };
}

export function selectEmbeddingNodes(nodes: string[], edges: GraphEdge[], limit: number): string[] {
  const { nodes: sorted, weights } = buildAdjacency(nodes, edges);
  const degree = sorted.map((_, position) =>
    weights[position].reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0),
  );
  return sorted
    .map((node, position) => ({ node, degree: degree[position] }))
    .sort((a, b) => b.degree - a.degree || a.node.localeCompare(b.node))
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.node);
}

function orthonormalize(vector: number[], basis: number[][]): number[] {
  const result = [...vector];
  for (const basisVector of basis) {
    let dot = 0;
    for (let i = 0; i < result.length; i++) dot += result[i] * basisVector[i];
    for (let i = 0; i < result.length; i++) result[i] -= dot * basisVector[i];
  }
  let norm = 0;
  for (const value of result) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm < 1e-12) return result.map(() => 0);
  return result.map((value) => value / norm);
}

function spectralVectors(weights: number[][], dimensions: number, seed: number): number[][] {
  const n = weights.length;
  const inverseSqrt = weights.map((row) => {
    const degree = row.reduce((sum, value) => sum + value, 0);
    return degree > 0 ? 1 / Math.sqrt(degree) : 0;
  });
  const normalized = weights.map((row, i) =>
    row.map((value, j) => inverseSqrt[i] * value * inverseSqrt[j]),
  );
  const random = mulberry32(seed);
  const columns: number[][] = [];
  const wanted = Math.min(dimensions, n);
  for (let column = 0; column < wanted; column++) {
    let vector = Array.from({ length: n }, () => random() * 2 - 1);
    vector = orthonormalize(vector, columns);
    for (let iteration = 0; iteration < 100; iteration++) {
      const next = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        const row = normalized[i];
        for (let j = 0; j < n; j++) sum += row[j] * vector[j];
        next[i] = sum;
      }
      const projected = orthonormalize(next, columns);
      if (projected.every((value) => Math.abs(value) < 1e-12)) break;
      vector = projected;
    }
    columns.push(vector);
  }
  const result = Array.from({ length: n }, (_, node) => {
    const row = columns.map((column) => column[node]);
    while (row.length < dimensions) row.push(0);
    return row.slice(0, dimensions);
  });
  return result;
}

function randomWalkVectors(
  weights: number[][],
  dimensions: number,
  seed: number,
  walks: number,
  steps: number,
): number[][] {
  const n = weights.length;
  const random = mulberry32(seed);
  const rowTotals = weights.map((row) => row.reduce((sum, value) => sum + value, 0));
  const visits = weights.map((_, start) => {
    const counts = new Array<number>(n).fill(0);
    for (let walk = 0; walk < walks; walk++) {
      counts[start] += 1;
      let current = start;
      for (let step = 0; step < steps; step++) {
        const total = rowTotals[current];
        if (total <= 0) break;
        const target = random() * total;
        const row = weights[current];
        let cursor = 0;
        let next = -1;
        for (let candidate = 0; candidate < n; candidate++) {
          cursor += row[candidate];
          if (row[candidate] > 0 && cursor >= target) {
            next = candidate;
            break;
          }
        }
        if (next < 0) break;
        counts[next] += 1;
        current = next;
      }
    }
    const normalizer = walks * (steps + 1);
    return counts.map((value) => value / normalizer);
  });

  const projection = Array.from({ length: n }, () =>
    Array.from({ length: dimensions }, () => (random() < 0.5 ? -1 : 1)),
  );
  const scale = 1 / Math.sqrt(dimensions);
  return visits.map((vector) => {
    const row = new Array<number>(dimensions).fill(0);
    for (let i = 0; i < n; i++) {
      const value = vector[i];
      if (value === 0) continue;
      const projectionRow = projection[i];
      for (let j = 0; j < dimensions; j++) row[j] += value * projectionRow[j];
    }
    return row.map((value) => value * scale);
  });
}

function ensureNonZero(vector: number[]): number[] {
  if (vector.some((value) => Number.isFinite(value) && value !== 0)) return vector;
  const padded = [...vector];
  padded[0] = 1;
  return padded;
}

export function embedGraph(nodes: string[], edges: GraphEdge[], options: EmbeddingOptions = {}): GraphEmbedding {
  const algorithm = assertAlgorithm(options.algorithm ?? "random-walk");
  const dimensions = options.dimensions ?? 64;
  assertDimensions(dimensions);
  const seed = options.seed ?? 1;
  const walks = options.walks ?? 20;
  const steps = options.steps ?? 8;
  const limit = options.limit ?? MAX_EMBEDDING_NODES;
  if (!Number.isInteger(walks) || walks < 1 || !Number.isInteger(steps) || steps < 1) {
    throw new Error("walks and steps must be positive integers");
  }
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");

  const selected = selectEmbeddingNodes(nodes, edges, limit);
  const { weights } = buildAdjacency(selected, edges);
  const vectors =
    algorithm === "spectral"
      ? spectralVectors(weights, dimensions, seed)
      : randomWalkVectors(weights, dimensions, seed, walks, steps);
  return {
    model: modelId(algorithm),
    algorithm,
    dimensions,
    nodes: selected,
    vectors: vectors.map(ensureNonZero),
  };
}

export async function computeGraphEmbeddings(
  c: Client,
  options: EmbeddingOptions = {},
): Promise<{ model: string; dimensions: number; entities: number; nodes: string[] }> {
  const algorithm = assertAlgorithm(options.algorithm ?? "random-walk");
  const dimensions = options.dimensions ?? 64;
  assertDimensions(dimensions);

  const relations = await c.query<{ source_entity_id: string; target_entity_id: string; weight: number }>(
    `SELECT source_entity_id, target_entity_id, weight
     FROM ip_entity_relations
     WHERE valid_to IS NULL
     ORDER BY source_entity_id, target_entity_id`,
  );
  const nodes = [...new Set(relations.rows.flatMap((row) => [row.source_entity_id, row.target_entity_id]))];
  const model = modelId(algorithm);
  if (!nodes.length) return { model, dimensions, entities: 0, nodes: [] };

  const embedding = embedGraph(
    nodes,
    relations.rows.map((row) => ({
      source: row.source_entity_id,
      target: row.target_entity_id,
      weight: row.weight,
    })),
    { ...options, algorithm, dimensions },
  );

  for (const [position, node] of embedding.nodes.entries()) {
    await putEmbedding(c, node, embedding.model, embedding.vectors[position]);
  }
  return {
    model: embedding.model,
    dimensions: embedding.dimensions,
    entities: embedding.nodes.length,
    nodes: embedding.nodes,
  };
}
