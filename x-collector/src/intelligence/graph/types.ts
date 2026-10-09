/**
 * Knowledge Graph v1 — структурированные связи между авторами X, твитами,
 * сущностями и токенами. Без AI, без embeddings, без новых таблиц:
 * источник — twitter_tweets + tweet_entities (+ tweet_token_links для mints).
 *
 * Топология:
 *   AUTHOR --AUTHORED--> TWEET
 *   TWEET  --MENTIONS--> ENTITY   (tweet_entities: MENTION | URL | HASHTAG)
 *   TWEET  --CONTAINS--> TOKEN    (tweet_entities: TOKEN + mints из tweet_token_links)
 *   ENTITY/TOKEN --CO_OCCURS--> ENTITY/TOKEN  (≥2 сущности в одном твите, без направления)
 */

export type NodeType = "AUTHOR" | "ENTITY" | "TOKEN" | "TWEET";

export interface GraphNode {
  /** Уникальный id с префиксом типа: author:<handle> · tweet:<id> · entity:<value> · token:<value>. */
  id: string;
  type: NodeType;
  /** Отображаемое имя: handle / tweet_id / значение сущности. */
  label: string;
}

export type EdgeType = "AUTHORED" | "MENTIONS" | "CONTAINS" | "CO_OCCURS";

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  /** Сила связи: число твитов, давших это ребро (CO_OCCURS — число совместных твитов). */
  weight: number;
}

export interface GraphMeta {
  nodeCount: number;
  edgeCount: number;
  /** Сколько твитов обработано при сборке. */
  tweetsProcessed: number;
  generatedAt: number;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: GraphMeta;
}

/** Узел автора. handle нормализуется в нижний регистр. */
export function authorNodeId(handle: string): string {
  return `author:${handle.toLowerCase()}`;
}

export function tweetNodeId(tweetId: string): string {
  return `tweet:${tweetId}`;
}

/** Узел сущности не-TOKEN (MENTION | URL | HASHTAG). Значение сохраняет регистр. */
export function entityNodeId(value: string): string {
  return `entity:${value}`;
}

/** Узел токена: тикер из tweet_entities либо mint из tweet_token_links. */
export function tokenNodeId(value: string): string {
  return `token:${value}`;
}

/** Тип узла по id; null — id не распознан. */
export function nodeIdType(id: string): NodeType | null {
  if (id.startsWith("author:")) return "AUTHOR";
  if (id.startsWith("tweet:")) return "TWEET";
  if (id.startsWith("entity:")) return "ENTITY";
  if (id.startsWith("token:")) return "TOKEN";
  return null;
}

/** label узла (id без префикса типа). */
export function nodeIdLabel(id: string): string {
  const i = id.indexOf(":");
  return i < 0 ? id : id.slice(i + 1);
}

/** Детерминированный порядок: тип (AUTHOR < ENTITY < TOKEN < TWEET) → label → id. */
export function compareNodes(a: GraphNode, b: GraphNode): number {
  return a.type.localeCompare(b.type) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

/** Детерминированный порядок: тип → from → to. */
export function compareEdges(a: GraphEdge, b: GraphEdge): number {
  return a.type.localeCompare(b.type) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
}
