import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { metrics } from "../src/core/metrics";
import {
  getAuthorNetwork, getRelatedEntities, topAuthors, topEntities, topRelations,
} from "../src/intelligence/graph/analytics";
import {
  buildGraphFromTweets, buildKnowledgeGraph, type GraphTweetInput,
} from "../src/intelligence/graph/builder";
import {
  MAX_EMBEDDING_DIMENSIONS,
  computeGraphEmbeddings,
  embedGraph,
} from "../lib/intelligence/graph-embeddings";
import { predictLinks } from "../lib/intelligence/link-prediction";
import { compareNeighbourhoods } from "../lib/intelligence/similarity-engine";
import { calculateCentrality, calculateWeightedCentrality, pageRank } from "../lib/intelligence/centrality-engine";
import { detectCommunities } from "../lib/intelligence/community-detection";

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


test("graph embeddings: dimension, determinism, model id", () => {
  const nodes = ["a", "b", "c", "d", "e"];
  const edges = [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
    { source: "c", target: "d" },
    { source: "d", target: "a" },
    { source: "a", target: "c" },
  ];

  const first = embedGraph(nodes, edges, { algorithm: "random-walk", dimensions: 8, seed: 7 });
  assert.equal(first.model, "random-walk@1");
  assert.equal(first.dimensions, 8);
  assert.equal(first.nodes.length, 5);
  assert.equal(first.vectors.length, 5);
  for (const vector of first.vectors) {
    assert.equal(vector.length, 8);
    assert.ok(vector.some((value) => value !== 0));
  }

  const again = embedGraph(nodes, edges, { algorithm: "random-walk", dimensions: 8, seed: 7 });
  assert.deepEqual(again.vectors, first.vectors);

  const otherSeed = embedGraph(nodes, edges, { algorithm: "random-walk", dimensions: 8, seed: 8 });
  assert.notDeepEqual(otherSeed.vectors, first.vectors);

  const spectral = embedGraph(nodes, edges, { algorithm: "spectral", dimensions: 8, seed: 7 });
  assert.equal(spectral.model, "spectral@1");
  assert.equal(spectral.vectors.length, 5);
  assert.notDeepEqual(spectral.vectors, first.vectors);

  const padded = embedGraph(nodes, edges, { algorithm: "spectral", dimensions: 32 });
  assert.equal(padded.vectors.length, 5);
  assert.ok(padded.vectors.every((vector) => vector.length === 32));

  assert.deepEqual(embedGraph([], []), {
    model: "random-walk@1",
    algorithm: "random-walk",
    dimensions: 64,
    nodes: [],
    vectors: [],
  });
  assert.throws(() => embedGraph(nodes, edges, { dimensions: 0 }));
  assert.throws(() => embedGraph(nodes, edges, { dimensions: MAX_EMBEDDING_DIMENSIONS + 1 }));
  assert.throws(() => embedGraph(nodes, edges, { algorithm: "nope" as never }));
  assert.throws(() => embedGraph(nodes, edges, { walks: 0 }));
});

test("link prediction: ranking and no automatic relation creation", async () => {
  const db = new PGlite();
  const c = { query: (sql: string, args: unknown[] = []) => db.query(sql, args) } as unknown as Pick<PoolClient, "query">;
  try {
    for (const name of ["023_intelligence_platform.sql", "024_intelligence_temporal.sql"]) {
      await db.exec(await fs.readFile("migrations/" + name, "utf8"));
    }

    const ids = new Map<string, string>();
    for (const name of ["a", "b", "c", "d", "e"]) {
      const id = randomUUID();
      ids.set(name, id);
      const eventId = randomUUID();
      await db.query(
        `INSERT INTO ip_raw_events(id,source,event_type,external_id,payload,payload_hash,collected_at)
         VALUES($1,'X','TWEET',$2,$3::jsonb,$4,now())`,
        [eventId, "event-" + eventId, JSON.stringify({ fixture: name }), "hash-" + eventId],
      );
      await db.query(
        `INSERT INTO ip_entities(id,type,name,external_id,platform) VALUES($1,'ACCOUNT',$2,$3,'X')`,
        [id, name, name],
      );
    }


    const link = async (left: string, right: string) => {
      const eventId = randomUUID();
      await db.query(
        `INSERT INTO ip_raw_events(id,source,event_type,external_id,payload,payload_hash,collected_at)
         VALUES($1,'X','TWEET',$2,$3::jsonb,$4,now())`,
        [eventId, "event-" + eventId, JSON.stringify({ fixture: eventId }), "hash-" + eventId],
      );
      await db.query(
        `INSERT INTO ip_entity_relations
           (id,source_entity_id,target_entity_id,relation_type,confidence,first_seen,last_seen,valid_from,source_event_id)
         VALUES($1,$2,$3,'SHARED',1,now(),now(),now(),$4)`,
        [randomUUID(), ids.get(left)!, ids.get(right)!, eventId],
      );
    };
    await link("a", "b");
    await link("a", "c");
    await link("b", "c");
    await link("b", "d");
    await link("c", "d");
    await link("a", "e");

    const before = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ip_entity_relations`);
    const nodes = ["a", "b", "c", "d", "e"].map((name) => ids.get(name)!);
    const edges = ["a|b", "a|c", "b|c", "b|d", "c|d", "a|e"].map((pair) => {
      const [source, target] = pair.split("|");
      return { source: ids.get(source)!, target: ids.get(target)! };
    });

    const predictions = predictLinks(nodes, edges, { limit: 10 });
    assert.ok(predictions.length > 0);
    assert.equal(predictions[0].method, "common-neighbours");
    assert.deepEqual(
      [predictions[0].from, predictions[0].to].sort(),
      [ids.get("a")!, ids.get("d")!].sort(),
    );

    const common = predictions.filter((entry) => entry.method === "common-neighbours");
    const findPair = (left: string, right: string) =>
      common.find((entry) => (entry.from === left && entry.to === right) || (entry.from === right && entry.to === left));
    const ad = findPair(ids.get("a")!, ids.get("d")!)!;
    const be = findPair(ids.get("b")!, ids.get("e")!)!;
    const de = findPair(ids.get("d")!, ids.get("e")!)!;
    assert.ok(ad.score > be.score);
    assert.ok(be.score > de.score);
    assert.equal(de.score, 0);
    assert.deepEqual([...ad.evidence].sort(), [ids.get("b")!, ids.get("c")!].sort());

    const preferential = predictions.filter((entry) => entry.method === "preferential-attachment");
    assert.ok(preferential.length >= 4);
    assert.ok(preferential[0].score >= preferential[preferential.length - 1].score);


    const repeat = predictLinks(nodes, edges, { limit: 10 });
    assert.deepEqual(repeat, predictions);

    const after = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ip_entity_relations`);
    assert.equal(after.rows[0].count, before.rows[0].count);

    const embeddings = await computeGraphEmbeddings(c, { algorithm: "spectral", dimensions: 4 });
    assert.equal(embeddings.model, "spectral@1");
    assert.equal(embeddings.dimensions, 4);
    assert.equal(embeddings.entities, 5);
    const stored = await db.query<{ dimensions: number; model: string }>(
      `SELECT dimensions, model FROM ip_entity_embeddings`,
    );
    assert.equal(stored.rows.length, 5);
    assert.ok(stored.rows.every((row) => row.dimensions === 4 && row.model === "spectral@1"));
  } finally {
    await db.close();
  }
});

test("graph engines: similarity, centrality, communities are deterministic", () => {
  assert.equal(compareNeighbourhoods("e", ["b", "c"], ["b", "c"]).similarity, 1);
  assert.equal(compareNeighbourhoods("e", ["b", "c"], ["a", "b"]).similarity, 1 / 3);
  assert.equal(compareNeighbourhoods("e", [], []).similarity, 0);

  const ranked = calculateCentrality([
    { id: "a", connections: ["b", "c"] },
    { id: "b", connections: ["a"] },
    { id: "c", connections: [] },
  ]);
  assert.deepEqual(ranked.map((entry) => entry.id), ["a", "b", "c"]);

  const weighted = calculateWeightedCentrality(
    ["a", "b", "c"],
    [
      { from: "a", to: "b", weight: 5 },
      { from: "b", to: "c", weight: 1 },
    ],
  );
  assert.deepEqual(weighted.map((entry) => entry.id), ["b", "a", "c"]);
  assert.equal(weighted[0].centrality, 6);

  const pr = pageRank(["a", "b"], [{ from: "a", to: "b" }]);
  const total = pr.reduce((sum, entry) => sum + entry.centrality, 0);
  assert.ok(Math.abs(total - 1) < 1e-6);
  assert.equal(pr[0].id, "b");
  assert.deepEqual(pageRank(["a", "b"], [{ from: "a", to: "b" }]), pr);
  assert.throws(() => pageRank(["a"], [], { damping: 1 }));

  const triangles = detectCommunities(
    ["a", "b", "c", "x", "y", "z"],
    [
      ["a", "b"], ["b", "c"], ["c", "a"],
      ["x", "y"], ["y", "z"], ["z", "x"],
    ],
  );
  assert.equal(triangles.length, 2);
  assert.ok(triangles.every((community) => community.members.length === 3 && community.density === 1));
  assert.deepEqual(detectCommunities(["a", "b", "c", "x", "y", "z"], [
    ["b", "a"], ["c", "b"], ["a", "c"],
    ["y", "x"], ["z", "y"], ["x", "z"],
  ]), triangles);

  const star = detectCommunities(
    ["c", "l1", "l2", "l3", "l4"],
    [["c", "l1"], ["c", "l2"], ["c", "l3"], ["c", "l4"]],
  );
  assert.equal(star.length, 1);
  assert.equal(star[0].members.length, 5);
  assert.deepEqual(detectCommunities([], []), []);
});
