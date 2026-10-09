import { metrics } from "../../core/metrics";
import { authorNodeId, nodeIdLabel, type GraphEdge, type GraphNode, type KnowledgeGraph, type NodeType } from "./types";

/**
 * Relationship Analytics v1 — чистые запросы к построенному графу (без БД).
 * Источник — KnowledgeGraph из builder.buildKnowledgeGraph().
 *
 * «connections» — число связанных сущностей (degree по CO_OCCURS);
 * «weight» — сила связи (число совместных твитов).
 */

export interface RelatedEntity {
  /** Соседняя сущность (label). */
  entity: string;
  /** Сколько сущностей связано с соседом в графе (его degree). */
  connections: number;
  /** Вес связи с источником: число твитов, где пара встретилась. */
  weight: number;
}

export interface AuthorEntity {
  entity: string;
  type: NodeType;
  /** Сколько твитов автора содержат сущность. */
  tweets: number;
}

export interface RelatedAuthor {
  handle: string;
  /** Сколько сущностей упоминают оба автора. */
  sharedEntities: number;
  /** Сумма твитов соседа по общим сущностям. */
  weight: number;
}

export interface AuthorNetwork {
  author: string;
  /** Твитов автора в графе (сумма весов AUTHORED). */
  tweets: number;
  entities: AuthorEntity[];
  relatedAuthors: RelatedAuthor[];
}

export interface EntityTop {
  entity: string;
  type: NodeType;
  /** Число связанных сущностей (degree по CO_OCCURS). */
  connections: number;
  /** Твитов, содержащих сущность (сумма весов MENTIONS/CONTAINS). */
  mentions: number;
}

export interface AuthorTop {
  handle: string;
  tweets: number;
  /** Сколько уникальных сущностей упоминает автор. */
  entities: number;
}

export interface RelationTop {
  /** label первой сущности пары. */
  from: string;
  /** label второй сущности пары. */
  to: string;
  weight: number;
}

export const DEFAULT_RELATED_LIMIT = 20;
export const DEFAULT_NETWORK_ENTITY_LIMIT = 20;
export const DEFAULT_NETWORK_AUTHOR_LIMIT = 10;
export const DEFAULT_TOP_LIMIT = 10;

interface GraphIndex {
  nodeById: Map<string, GraphNode>;
  /** label в нижнем регистре → узлы (ENTITY и TOKEN одного значения различаются id). */
  byLabel: Map<string, GraphNode[]>;
  /** from → исходящие рёбра. */
  out: Map<string, GraphEdge[]>;
  /** to → входящие рёбра. */
  in: Map<string, GraphEdge[]>;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function indexGraph(graph: KnowledgeGraph): GraphIndex {
  const idx: GraphIndex = {
    nodeById: new Map(),
    byLabel: new Map(),
    out: new Map(),
    in: new Map(),
  };
  for (const node of graph.nodes) {
    idx.nodeById.set(node.id, node);
    push(idx.byLabel, node.label.toLowerCase(), node);
  }
  for (const edge of graph.edges) {
    push(idx.out, edge.from, edge);
    push(idx.in, edge.to, edge);
  }
  return idx;
}

function isEntityNode(node: GraphNode): boolean {
  return node.type === "ENTITY" || node.type === "TOKEN";
}

/** Label узла по id; если узла нет — id без префикса. */
function labelOf(idx: GraphIndex, id: string): string {
  return idx.nodeById.get(id)?.label ?? nodeIdLabel(id);
}

/** degree по CO_OCCURS: id узла → число связанных сущностей. */
function coOccurrenceDegree(graph: KnowledgeGraph): Map<string, number> {
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.type !== "CO_OCCURS") continue;
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  return degree;
}

/**
 * Сущности, связанные с данной, отсортированные по числу совместных твитов.
 * `entity` ищется по label без учёта регистра (ENTITY и TOKEN считаются алиасами).
 */
export function getRelatedEntities(
  entity: string,
  graph: KnowledgeGraph,
  options: { limit?: number } = {},
): RelatedEntity[] {
  metrics.relationshipsCalculated += 1;
  const limit = options.limit ?? DEFAULT_RELATED_LIMIT;
  const idx = indexGraph(graph);
  const sources = (idx.byLabel.get(entity.trim().toLowerCase()) ?? []).filter(isEntityNode);
  if (sources.length === 0) return [];
  const sourceIds = new Set(sources.map((n) => n.id));

  const degree = coOccurrenceDegree(graph);
  const weights = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.type !== "CO_OCCURS") continue;
    const fromIn = sourceIds.has(edge.from);
    const toIn = sourceIds.has(edge.to);
    if (fromIn === toIn) continue; // оба конца — источник (алиасы) или пара вне источника
    const neighbor = fromIn ? edge.to : edge.from;
    weights.set(neighbor, (weights.get(neighbor) ?? 0) + edge.weight);
  }

  const rows: RelatedEntity[] = [...weights.entries()].map(([id, weight]) => ({
    entity: labelOf(idx, id),
    connections: degree.get(id) ?? 0,
    weight,
  }));
  rows.sort((a, b) => b.weight - a.weight || a.entity.localeCompare(b.entity));
  return limit > 0 ? rows.slice(0, limit) : rows;
}

/** Сущности автора: AUTHOR → AUTHORED → TWEET → MENTIONS/CONTAINS → ENTITY/TOKEN. */
function authorEntities(idx: GraphIndex, authorId: string): Map<string, AuthorEntity & { id: string }> {
  const out = new Map<string, AuthorEntity & { id: string }>();
  for (const authored of idx.out.get(authorId) ?? []) {
    if (authored.type !== "AUTHORED") continue;
    for (const edge of idx.out.get(authored.to) ?? []) {
      if (edge.type !== "MENTIONS" && edge.type !== "CONTAINS") continue;
      const node = idx.nodeById.get(edge.to);
      if (!node || !isEntityNode(node)) continue;
      const key = node.label.toLowerCase();
      let agg = out.get(key);
      if (!agg) {
        agg = { id: node.id, entity: node.label, type: node.type, tweets: 0 };
        out.set(key, agg);
      }
      agg.tweets += edge.weight;
    }
  }
  return out;
}

/**
 * Сеть автора: автор → его сущности → авторы, упоминающие те же сущности.
 * Пустая сеть (tweets 0), если автора нет в графе.
 */
export function getAuthorNetwork(
  handle: string,
  graph: KnowledgeGraph,
  options: { entityLimit?: number; authorLimit?: number } = {},
): AuthorNetwork {
  metrics.relationshipsCalculated += 1;
  const idx = indexGraph(graph);
  const authorId = authorNodeId(handle);
  const authored = (idx.out.get(authorId) ?? []).filter((e) => e.type === "AUTHORED");
  const tweets = authored.reduce((sum, e) => sum + e.weight, 0);

  const entities = [...authorEntities(idx, authorId).values()];
  const entityLimit = options.entityLimit ?? DEFAULT_NETWORK_ENTITY_LIMIT;

  const sharedByAuthor = new Map<string, { shared: Set<string>; weight: number }>();
  for (const own of entities) {
    for (const edge of idx.in.get(own.id) ?? []) {
      if (edge.type !== "MENTIONS" && edge.type !== "CONTAINS") continue;
      // edge.from — твит; автор — по ребру AUTHORED (author → tweet).
      for (const authoredOfTweet of idx.in.get(edge.from) ?? []) {
        if (authoredOfTweet.type !== "AUTHORED" || authoredOfTweet.from === authorId) continue;
        let rec = sharedByAuthor.get(authoredOfTweet.from);
        if (!rec) {
          rec = { shared: new Set(), weight: 0 };
          sharedByAuthor.set(authoredOfTweet.from, rec);
        }
        rec.shared.add(own.entity.toLowerCase());
        rec.weight += authoredOfTweet.weight * edge.weight;
      }
    }
  }
  const authorLimit = options.authorLimit ?? DEFAULT_NETWORK_AUTHOR_LIMIT;
  const relatedAuthors = [...sharedByAuthor.entries()]
    .map(([id, rec]) => ({ handle: labelOf(idx, id), sharedEntities: rec.shared.size, weight: rec.weight }))
    .sort((a, b) => b.weight - a.weight || b.sharedEntities - a.sharedEntities || a.handle.localeCompare(b.handle))
    .slice(0, authorLimit > 0 ? authorLimit : undefined);

  const sortedEntities = entities
    .map(({ id: _id, ...rest }) => rest)
    .sort((a, b) => b.tweets - a.tweets || a.entity.localeCompare(b.entity));

  return {
    author: idx.nodeById.get(authorId)?.label ?? handle,
    tweets,
    entities: entityLimit > 0 ? sortedEntities.slice(0, entityLimit) : sortedEntities,
    relatedAuthors,
  };
}

/** Топ сущностей: degree CO_OCCURS DESC → mentions DESC → label ASC. */
export function topEntities(graph: KnowledgeGraph, limit = DEFAULT_TOP_LIMIT): EntityTop[] {
  metrics.relationshipsCalculated += 1;
  const degree = coOccurrenceDegree(graph);
  const mentions = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.type !== "MENTIONS" && edge.type !== "CONTAINS") continue;
    mentions.set(edge.to, (mentions.get(edge.to) ?? 0) + edge.weight);
  }

  const rows: EntityTop[] = [];
  for (const node of graph.nodes) {
    if (!isEntityNode(node)) continue;
    rows.push({
      entity: node.label,
      type: node.type,
      connections: degree.get(node.id) ?? 0,
      mentions: mentions.get(node.id) ?? 0,
    });
  }
  rows.sort((a, b) =>
    b.connections - a.connections || b.mentions - a.mentions || a.entity.localeCompare(b.entity));
  return limit > 0 ? rows.slice(0, limit) : rows;
}

/** Топ авторов: уникальные сущности DESC → твиты DESC → handle ASC. */
export function topAuthors(graph: KnowledgeGraph, limit = DEFAULT_TOP_LIMIT): AuthorTop[] {
  metrics.relationshipsCalculated += 1;
  const idx = indexGraph(graph);
  const tweetsByAuthor = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.type !== "AUTHORED") continue;
    tweetsByAuthor.set(edge.from, (tweetsByAuthor.get(edge.from) ?? 0) + edge.weight);
  }

  const rows: AuthorTop[] = [...tweetsByAuthor.entries()].map(([id, tweets]) => ({
    handle: labelOf(idx, id),
    tweets,
    entities: authorEntities(idx, id).size,
  }));
  rows.sort((a, b) => b.entities - a.entities || b.tweets - a.tweets || a.handle.localeCompare(b.handle));
  return limit > 0 ? rows.slice(0, limit) : rows;
}

/** Топ связей CO_OCCURS: weight DESC → from ASC → to ASC (label'ы, не id). */
export function topRelations(graph: KnowledgeGraph, limit = DEFAULT_TOP_LIMIT): RelationTop[] {
  metrics.relationshipsCalculated += 1;
  const idx = indexGraph(graph);
  const rows: RelationTop[] = graph.edges
    .filter((edge) => edge.type === "CO_OCCURS")
    .map((edge) => ({ from: labelOf(idx, edge.from), to: labelOf(idx, edge.to), weight: edge.weight }))
    .sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return limit > 0 ? rows.slice(0, limit) : rows;
}
