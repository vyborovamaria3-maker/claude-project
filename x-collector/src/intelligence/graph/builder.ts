import { q } from "../../../lib/trade/pg";
import { metrics } from "../../core/metrics";
import {
  authorNodeId, compareEdges, compareNodes, entityNodeId, tokenNodeId, tweetNodeId,
  type GraphEdge, type GraphNode, type KnowledgeGraph, type NodeType,
} from "./types";

/** Сущность одного твита в входных данных графа. */
export interface GraphTweetEntity {
  /** entity_type из tweet_entities: TOKEN | MENTION | URL | HASHTAG (замешанные значения уходят в ENTITY). */
  type: string;
  value: string;
}

/** Твит со связанными сущностями: twitter_tweets + tweet_entities (+ tweet_token_links). */
export interface GraphTweetInput {
  tweetId: string;
  handle: string;
  entities: GraphTweetEntity[];
  /** mints из tweet_token_links. */
  mints?: string[];
}

export interface BuildGraphOptions {
  /** Готовые данные: при задании БД не читается (используется в тестах и офлайне). */
  tweets?: GraphTweetInput[];
  /** Окно в часах от текущего момента. Без значения — вся история. */
  hours?: number;
  /** Сколько твитов максимум загрузить. default 1000 */
  limit?: number;
  /** Учитывать mints из tweet_token_links как TOKEN-узлы. default true */
  includeMints?: boolean;
  /** Максимум узлов на твит для CO_OCCURS (защита от взрыва пар). default 10 */
  maxEntitiesPerTweet?: number;
}

export const DEFAULT_GRAPH_LIMIT = 1000;
export const DEFAULT_MAX_ENTITIES_PER_TWEET = 10;

interface BuildState {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  includeMints: boolean;
  maxEntitiesPerTweet: number;
}

function addNode(state: BuildState, id: string, type: NodeType, label: string): void {
  if (state.nodes.has(id)) return;
  state.nodes.set(id, { id, type, label });
}

function addEdge(state: BuildState, type: GraphEdge["type"], from: string, to: string): void {
  const key = `${type}|${from}|${to}`;
  const existing = state.edges.get(key);
  if (existing) {
    existing.weight += 1;
    return;
  }
  state.edges.set(key, { from, to, type, weight: 1 });
}

/**
 * Чистая сборка графа из готовых твитов. Ничего не пишет в БД.
 *
 * На каждый твит: AUTHOR + TWEET узлы и ребро AUTHORED; сущности → узлы
 * ENTITY/TOKEN и рёбра TWEET→ENTITY (MENTIONS) / TWEET→TOKEN (CONTAINS);
 * все пары различных сущностей твита → рёбра CO_OCCURS (направление
 * канонизируется from < to, вес = число совместных твитов).
 */
export function buildGraphFromTweets(
  tweets: GraphTweetInput[],
  options: BuildGraphOptions = {},
): KnowledgeGraph {
  const state: BuildState = {
    nodes: new Map(),
    edges: new Map(),
    includeMints: options.includeMints ?? true,
    maxEntitiesPerTweet: options.maxEntitiesPerTweet ?? DEFAULT_MAX_ENTITIES_PER_TWEET,
  };

  let tweetsProcessed = 0;
  for (const tweet of tweets) {
    if (!tweet?.tweetId || !tweet.handle) continue;
    tweetsProcessed += 1;

    const authorId = authorNodeId(tweet.handle);
    const tweetId = tweetNodeId(tweet.tweetId);
    addNode(state, authorId, "AUTHOR", tweet.handle);
    addNode(state, tweetId, "TWEET", tweet.tweetId);
    addEdge(state, "AUTHORED", authorId, tweetId);

    const coIds: string[] = [];
    const seen = new Set<string>();
    const pushEntity = (raw: GraphTweetEntity | string, isMint: boolean): void => {
      const type = isMint ? "TOKEN" : (typeof raw === "string" ? "" : raw.type);
      const value = typeof raw === "string" ? raw : raw.value;
      if (!value) return;
      const nodeType: NodeType = type === "TOKEN" ? "TOKEN" : "ENTITY";
      const id = nodeType === "TOKEN" ? tokenNodeId(value) : entityNodeId(value);
      if (seen.has(id)) return;
      seen.add(id);
      addNode(state, id, nodeType, value);
      addEdge(state, nodeType === "TOKEN" ? "CONTAINS" : "MENTIONS", tweetId, id);
      coIds.push(id);
    };

    for (const entity of tweet.entities ?? []) pushEntity(entity, false);
    if (state.includeMints) for (const mint of tweet.mints ?? []) pushEntity(mint, true);

    const limited = coIds.slice(0, state.maxEntitiesPerTweet);
    for (let i = 0; i < limited.length; i++) {
      for (let j = i + 1; j < limited.length; j++) {
        const a = limited[i];
        const b = limited[j];
        // Один и тот же тикер/значение в разных типах — не пара.
        if (nodeLabelEquals(a, b)) continue;
        const [from, to] = a < b ? [a, b] : [b, a];
        addEdge(state, "CO_OCCURS", from, to);
      }
    }
  }

  const nodes = [...state.nodes.values()].sort(compareNodes);
  const edges = [...state.edges.values()].sort(compareEdges);
  metrics.graphNodesBuilt += nodes.length;
  metrics.graphEdgesBuilt += edges.length;

  return {
    nodes,
    edges,
    meta: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      tweetsProcessed,
      generatedAt: Date.now(),
    },
  };
}

function nodeLabelEquals(a: string, b: string): boolean {
  const i = a.indexOf(":");
  const j = b.indexOf(":");
  return a.slice(i + 1).toLowerCase() === b.slice(j + 1).toLowerCase();
}

interface RawTweetRow {
  tweet_id: string;
  handle: string;
  entities: Array<{ type?: unknown; value?: unknown }> | null;
  mints: string[] | null;
}

async function fetchGraphTweets(options: BuildGraphOptions): Promise<GraphTweetInput[]> {
  const params: unknown[] = [];
  let where = "";
  if (options.hours != null && options.hours > 0) {
    params.push(Date.now() - options.hours * 3_600_000);
    where = `WHERE COALESCE(t.posted_at, t.first_seen_at) >= $${params.length}`;
  }
  params.push(
    Number.isFinite(options.limit) && (options.limit as number) > 0
      ? Math.floor(options.limit as number)
      : DEFAULT_GRAPH_LIMIT,
  );

  const rows = await q<RawTweetRow>(
    `SELECT t.tweet_id,
            t.handle,
            COALESCE(jsonb_agg(DISTINCT jsonb_build_object('type', e.entity_type, 'value', e.value))
                     FILTER (WHERE e.id IS NOT NULL), '[]'::jsonb) AS entities,
            COALESCE(array_agg(DISTINCT l.mint) FILTER (WHERE l.mint IS NOT NULL), '{}') AS mints
       FROM twitter_tweets t
       LEFT JOIN tweet_entities e ON e.tweet_id = t.tweet_id
       LEFT JOIN tweet_token_links l ON l.tweet_id = t.tweet_id
       ${where}
      GROUP BY t.tweet_id
      ORDER BY COALESCE(t.posted_at, t.first_seen_at) DESC NULLS LAST
      LIMIT $${params.length}`,
    params,
  );

  return rows.map((r) => ({
    tweetId: r.tweet_id,
    handle: r.handle,
    entities: (r.entities ?? [])
      .map((x) => ({ type: String(x?.type ?? ""), value: String(x?.value ?? "") }))
      .filter((x) => x.value.length > 0),
    mints: r.mints ?? [],
  }));
}

/**
 * Сборка графа: twitter_tweets → AUTHOR/TWEET, tweet_entities → ENTITY/TOKEN,
 * tweet_token_links → TOKEN (mints). Если задан options.tweets — БД не читается.
 */
export async function buildKnowledgeGraph(
  options: BuildGraphOptions = {},
): Promise<KnowledgeGraph> {
  const tweets = options.tweets ?? (await fetchGraphTweets(options));
  return buildGraphFromTweets(tweets, options);
}
