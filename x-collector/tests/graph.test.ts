import { test } from "node:test";
import assert from "node:assert/strict";
import { metrics } from "../src/core/metrics";
import {
  getAuthorNetwork, getRelatedEntities, topAuthors, topEntities, topRelations,
} from "../src/intelligence/graph/analytics";
import {
  buildGraphFromTweets, buildKnowledgeGraph, type GraphTweetInput,
} from "../src/intelligence/graph/builder";

const TWEETS: GraphTweetInput[] = [
  { tweetId: "t1", handle: "alice", entities: [
    { type: "TOKEN", value: "BTC" },
    { type: "HASHTAG", value: "crypto" },
  ] },
  { tweetId: "t2", handle: "bob", entities: [
    { type: "TOKEN", value: "BTC" },
    { type: "TOKEN", value: "ETH" },
  ] },
  { tweetId: "t3", handle: "alice", entities: [
    { type: "TOKEN", value: "BTC" },
    { type: "TOKEN", value: "ETH" },
    { type: "MENTION", value: "bob" },
  ] },
];

function edgesOf<K extends { type: string }>(graph: { edges: K[] }, type: string): K[] {
  return graph.edges.filter((e) => e.type === type);
}

test("graph: author → tweet (AUTHORED)", () => {
  const nodesBefore = metrics.graphNodesBuilt;
  const edgesBefore = metrics.graphEdgesBuilt;
  const graph = buildGraphFromTweets(TWEETS);

  const ids = graph.nodes.map((n) => n.id);
  assert.ok(ids.includes("author:alice"));
  assert.ok(ids.includes("author:bob"));
  assert.ok(ids.includes("tweet:t1"));
  assert.ok(ids.includes("tweet:t2"));
  assert.ok(ids.includes("tweet:t3"));

  const authored = edgesOf(graph, "AUTHORED");
  assert.equal(authored.length, 3);
  assert.deepEqual(
    authored.map((e) => `${e.from}->${e.to}`).sort(),
    ["author:alice->tweet:t1", "author:alice->tweet:t3", "author:bob->tweet:t2"],
  );
  assert.ok(authored.every((e) => e.weight === 1));
  assert.equal(graph.meta.tweetsProcessed, 3);
  assert.equal(graph.meta.nodeCount, graph.nodes.length);
  assert.equal(graph.meta.edgeCount, graph.edges.length);
  assert.equal(graph.nodes.length, 9);
  assert.equal(graph.edges.length, 14);
  // метрики: на сколько узлов/рёбер выросли счётчики
  assert.equal(metrics.graphNodesBuilt - nodesBefore, graph.nodes.length);
  assert.equal(metrics.graphEdgesBuilt - edgesBefore, graph.edges.length);
});

test("graph: tweet → entity (MENTIONS) и tweet → token (CONTAINS)", () => {
  const graph = buildGraphFromTweets(TWEETS);
  const mentions = edgesOf(graph, "MENTIONS");
  const contains = edgesOf(graph, "CONTAINS");

  assert.deepEqual(
    mentions.map((e) => `${e.from}->${e.to}`).sort(),
    ["tweet:t1->entity:crypto", "tweet:t3->entity:bob"],
  );
  assert.deepEqual(
    contains.map((e) => `${e.from}->${e.to}`).sort(),
    [
      "tweet:t1->token:BTC",
      "tweet:t2->token:BTC",
      "tweet:t2->token:ETH",
      "tweet:t3->token:BTC",
      "tweet:t3->token:ETH",
    ],
  );
  assert.ok(mentions.every((e) => e.weight === 1));
  assert.ok(contains.every((e) => e.weight === 1));

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.equal(nodeById.get("entity:crypto")?.type, "ENTITY");
  assert.equal(nodeById.get("entity:bob")?.type, "ENTITY");
  assert.equal(nodeById.get("token:BTC")?.type, "TOKEN");
  assert.equal(nodeById.get("token:ETH")?.type, "TOKEN");
  assert.equal(nodeById.get("author:bob")?.label, "bob");
});

test("graph: entity co-occurrence — пара на твит, вес = число совместных твитов", () => {
  const graph = buildGraphFromTweets(TWEETS);
  const co = edgesOf(graph, "CO_OCCURS");

  assert.deepEqual(
    co.map((e) => ({ from: e.from, to: e.to, weight: e.weight })),
    [
      { from: "entity:bob", to: "token:BTC", weight: 1 },
      { from: "entity:bob", to: "token:ETH", weight: 1 },
      { from: "entity:crypto", to: "token:BTC", weight: 1 },
      { from: "token:BTC", to: "token:ETH", weight: 2 },
    ],
  );
  // нет петель, все концы существуют, направление канонизировано
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const e of co) {
    assert.notEqual(e.from, e.to);
    assert.ok(ids.has(e.from) && ids.has(e.to));
    assert.ok(e.from < e.to);
  }
});

test("graph: getRelatedEntities — weight DESC, connections = degree соседа", () => {
  const graph = buildGraphFromTweets(TWEETS);
  const before = metrics.relationshipsCalculated;

  const related = getRelatedEntities("BTC", graph);
  assert.equal(metrics.relationshipsCalculated, before + 1);
  assert.deepEqual(related, [
    { entity: "ETH", connections: 2, weight: 2 },
    { entity: "bob", connections: 2, weight: 1 },
    { entity: "crypto", connections: 1, weight: 1 },
  ]);

  // label без учёта регистра
  assert.deepEqual(getRelatedEntities("btc", graph), related);
  // неизвестная сущность и limit
  assert.deepEqual(getRelatedEntities("DOGE", graph), []);
  assert.equal(getRelatedEntities("BTC", graph, { limit: 1 }).length, 1);
});

test("graph: getAuthorNetwork — автор → сущности → связанные авторы", () => {
  const graph = buildGraphFromTweets(TWEETS);
  const before = metrics.relationshipsCalculated;

  const network = getAuthorNetwork("alice", graph);
  assert.equal(metrics.relationshipsCalculated, before + 1);
  assert.equal(network.author, "alice");
  assert.equal(network.tweets, 2);
  assert.deepEqual(
    network.entities.map((e) => `${e.entity}:${e.tweets}`),
    ["BTC:2", "bob:1", "crypto:1", "ETH:1"],
  );
  assert.equal(network.entities[0].type, "TOKEN");
  assert.deepEqual(network.relatedAuthors, [
    { handle: "bob", sharedEntities: 2, weight: 2 },
  ]);

  const bob = getAuthorNetwork("bob", graph);
  assert.equal(bob.tweets, 1);
  assert.deepEqual(bob.entities.map((e) => e.entity).sort(), ["BTC", "ETH"]);
  assert.deepEqual(bob.relatedAuthors, [
    // alice держит BTC в 2 твитах (t1, t3) + ETH в 1 (t3) → weight 3
    { handle: "alice", sharedEntities: 2, weight: 3 },
  ]);

  const empty = getAuthorNetwork("nobody", graph);
  assert.equal(empty.tweets, 0);
  assert.deepEqual(empty.entities, []);
  assert.deepEqual(empty.relatedAuthors, []);
});

test("graph: топы — entities, authors, relations", () => {
  const graph = buildGraphFromTweets(TWEETS);
  const before = metrics.relationshipsCalculated;

  assert.deepEqual(
    topEntities(graph).map((e) => `${e.entity}:${e.connections}/${e.mentions}`),
    ["BTC:3/3", "ETH:2/2", "bob:2/1", "crypto:1/1"],
  );
  assert.deepEqual(
    topAuthors(graph).map((a) => `${a.handle}:${a.entities}/${a.tweets}`),
    ["alice:4/2", "bob:2/1"],
  );
  assert.deepEqual(
    topRelations(graph).map((r) => `${r.from}↔${r.to}:${r.weight}`),
    ["BTC↔ETH:2", "bob↔BTC:1", "bob↔ETH:1", "crypto↔BTC:1"],
  );
  assert.equal(metrics.relationshipsCalculated, before + 3);
  assert.deepEqual(topEntities(buildGraphFromTweets([])), []);
  assert.deepEqual(topRelations(buildGraphFromTweets([])), []);
});

test("graph: tweet_token_links → TOKEN-узел и CONTAINS; includeMints=false", () => {
  const mint = "So11111111111111111111111111111111111111112";
  const withMint: GraphTweetInput[] = [
    { tweetId: "t9", handle: "carol", entities: [{ type: "TOKEN", value: "SOL" }], mints: [mint] },
  ];
  const graph = buildGraphFromTweets(withMint);
  const ids = graph.nodes.map((n) => n.id);
  assert.ok(ids.includes(`token:${mint}`));
  assert.ok(edgesOf(graph, "CONTAINS").some((e) => e.to === `token:${mint}`));

  const noMint = buildGraphFromTweets(withMint, { includeMints: false });
  assert.ok(!noMint.nodes.some((n) => n.id === `token:${mint}`));
});

test("graph: дубликаты, одинаковые значения и cap на пары", () => {
  const dup = buildGraphFromTweets([
    { tweetId: "d1", handle: "dan", entities: [
      { type: "TOKEN", value: "BTC" },
      { type: "TOKEN", value: "BTC" },
    ] },
  ]);
  assert.equal(edgesOf(dup, "CONTAINS").length, 1);
  assert.equal(edgesOf(dup, "CO_OCCURS").length, 0);
  assert.equal(dup.meta.nodeCount, 3); // author + tweet + token

  const mixed = buildGraphFromTweets([
    { tweetId: "d2", handle: "dan", entities: [
      { type: "TOKEN", value: "BTC" },
      { type: "HASHTAG", value: "btc" },
    ] },
  ]);
  // один и тот же тикер в разных типах — не пара, но узлы разные
  assert.equal(mixed.nodes.filter((n) => n.type !== "AUTHOR" && n.type !== "TWEET").length, 2);
  assert.equal(edgesOf(mixed, "CO_OCCURS").length, 0);

  const capped = buildGraphFromTweets(TWEETS, { maxEntitiesPerTweet: 1 });
  assert.equal(edgesOf(capped, "CO_OCCURS").length, 0);
  assert.equal(edgesOf(capped, "CONTAINS").length, 5); // узлы и рёбра к твиту не режутся
  assert.equal(edgesOf(capped, "MENTIONS").length, 2);
});

test("graph: детерминированная сортировка и мусор на входе", () => {
  const a = buildGraphFromTweets(TWEETS);
  const b = buildGraphFromTweets([...TWEETS].reverse());
  assert.deepEqual(a.nodes, b.nodes);
  assert.deepEqual(a.edges, b.edges);

  const noise = buildGraphFromTweets([
    { tweetId: "", handle: "", entities: [] },
    { tweetId: "ok", handle: "eve", entities: [{ type: "URL", value: "" }] },
  ]);
  assert.equal(noise.meta.tweetsProcessed, 1); // твит без id/handle пропущен
  assert.equal(noise.nodes.length, 2); // автор + твит, без узлов сущностей
  assert.equal(edgesOf(noise, "AUTHORED").length, 1); // пустое значение сущности не даёт узлов
});

test("graph: buildKnowledgeGraph({tweets}) — путь без БД", async () => {
  const graph = await buildKnowledgeGraph({ tweets: TWEETS });
  assert.equal(graph.meta.tweetsProcessed, 3);
  assert.equal(graph.nodes.length, 9);
  assert.equal(graph.edges.length, 14);
});
