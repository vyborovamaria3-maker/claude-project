import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateEntities, rankEntityStats, resolveTopEntitiesOptions,
  type EntityRecord, type EntityStat,
} from "../src/intelligence/analytics/entity-stats";
import { computeTrend, STABLE_GROWTH_THRESHOLD } from "../src/intelligence/analytics/trends";
import { aggregateAuthors, rankAuthors, type AuthorRecord } from "../src/intelligence/analytics/accounts";

const HOUR = 3_600_000;
const NOW = Date.now();

function entity(
  entity_type: string,
  value: string,
  tweet_id: string,
  ageMs: number,
): EntityRecord {
  const ts = NOW - ageMs;
  return { entity_type, value, tweet_id, extracted_at: ts, posted_at: ts };
}

const entityRows: EntityRecord[] = [
  entity("TOKEN", "BTC", "t1", 2 * HOUR),
  entity("TOKEN", "BTC", "t2", 3 * HOUR),
  entity("TOKEN", "BTC", "t2", 3 * HOUR), // повторная строка того же твита
  entity("TOKEN", "BTC", "t5", 50 * HOUR), // старый твит, вне окна 24h
  entity("TOKEN", "ETH", "t3", 5 * HOUR),
  entity("TOKEN", "SOL", "t4", 50 * HOUR), // вне окна 24h
  entity("HASHTAG", "crypto", "t1", 2 * HOUR),
  entity("HASHTAG", "solana", "t6", 50 * HOUR),
  entity("MENTION", "elon", "t3", 5 * HOUR),
];

test("entity counts: mentions и уникальные твиты внутри окна", () => {
  const tokens = aggregateEntities(entityRows, { type: "TOKEN", hours: 24 });
  assert.deepEqual(tokens.map((t) => t.value), ["BTC", "ETH"]);

  const btc = tokens[0];
  assert.equal(btc.entity_type, "TOKEN");
  assert.equal(btc.mentions, 3); // t1 + t2 дважды; t5 (50h назад) вне окна
  assert.equal(btc.unique_tweets, 2); // t1, t2
  assert.equal(btc.first_seen, NOW - 50 * HOUR); // first_seen не привязан к окну
  assert.equal(btc.last_seen, NOW - 2 * HOUR);
});

test("entity counts: сущности без упоминаний в окне отбрасываются", () => {
  const tokens = aggregateEntities(entityRows, { type: "TOKEN", hours: 24 });
  assert.equal(tokens.find((t) => t.value === "SOL"), undefined);

  const wide = aggregateEntities(entityRows, { type: "TOKEN", hours: 72 });
  assert.ok(wide.find((t) => t.value === "SOL"));
});

test("entity counts: фильтр по типу", () => {
  const tags = aggregateEntities(entityRows, { type: "HASHTAG", hours: 24 });
  assert.deepEqual(tags.map((t) => t.value), ["crypto"]);
  assert.equal(tags[0].mentions, 1);

  const mentionsOnly = aggregateEntities(entityRows, { type: "MENTION", hours: 24 });
  assert.deepEqual(mentionsOnly.map((t) => t.value), ["elon"]);
});

test("entity counts: без фильтра — все типы, limit урезает после сортировки", () => {
  const all = aggregateEntities(entityRows, { hours: 24 });
  assert.deepEqual(all.map((t) => `${t.entity_type}:${t.value}`), [
    "TOKEN:BTC",
    "HASHTAG:crypto",
    "MENTION:elon",
    "TOKEN:ETH",
  ]);
  assert.equal(aggregateEntities(entityRows, { hours: 24, limit: 2 }).length, 2);
  assert.deepEqual(aggregateEntities([], { hours: 24 }), []);
});

test("entity stats: сортировка mentions → unique_tweets → value", () => {
  const stats: EntityStat[] = [
    { entity_type: "TOKEN", value: "ZZZ", mentions: 5, unique_tweets: 1, first_seen: 1, last_seen: 2 },
    { entity_type: "TOKEN", value: "AAA", mentions: 5, unique_tweets: 4, first_seen: 1, last_seen: 2 },
    { entity_type: "TOKEN", value: "MMM", mentions: 5, unique_tweets: 4, first_seen: 1, last_seen: 2 },
    { entity_type: "TOKEN", value: "BBB", mentions: 9, unique_tweets: 1, first_seen: 1, last_seen: 2 },
  ];
  assert.deepEqual(rankEntityStats(stats).map((s) => s.value), ["BBB", "AAA", "MMM", "ZZZ"]);
  assert.deepEqual(rankEntityStats(stats, 2).map((s) => s.value), ["BBB", "AAA"]);
});

test("entity stats: дефолты и валидация опций", () => {
  assert.deepEqual(resolveTopEntitiesOptions(), { type: undefined, hours: 24, limit: 20 });
  assert.deepEqual(resolveTopEntitiesOptions({ hours: 0, limit: -5 }), { type: undefined, hours: 24, limit: 20 });
  assert.equal(resolveTopEntitiesOptions({ hours: 12.7, limit: 10_000 }).hours, 12);
  assert.equal(resolveTopEntitiesOptions({ limit: 10_000 }).limit, 500);
});

test("trend calculation: рост, падение, flat", () => {
  assert.deepEqual(computeTrend({ value: "BTC", current: 15, previous: 10 }), {
    value: "BTC", current: 15, previous: 10, growthPercent: 50, trend: "rising",
  });
  assert.deepEqual(computeTrend({ value: "ETH", current: 5, previous: 10 }), {
    value: "ETH", current: 5, previous: 10, growthPercent: -50, trend: "falling",
  });
  assert.deepEqual(computeTrend({ value: "SOL", current: 10, previous: 10 }), {
    value: "SOL", current: 10, previous: 10, growthPercent: 0, trend: "stable",
  });
  assert.equal(computeTrend({ value: "X", current: 100, previous: 95 }).trend, "stable");
  assert.equal(computeTrend({ value: "X", current: 95, previous: 100 }).growthPercent, -5);
});

test("trend calculation: нулевой предыдущий период и округление", () => {
  assert.deepEqual(computeTrend({ value: "NEW", current: 5, previous: 0 }), {
    value: "NEW", current: 5, previous: 0, growthPercent: 100, trend: "rising",
  });
  assert.equal(computeTrend({ value: "DEAD", current: 0, previous: 0 }).growthPercent, 0);
  assert.equal(computeTrend({ value: "GONE", current: 0, previous: 7 }).trend, "falling");
  assert.equal(computeTrend({ value: "R", current: 4, previous: 3 }).growthPercent, 33.33);
});

test("trend calculation: граница порога stable", () => {
  assert.equal(computeTrend({ value: "A", current: 11, previous: 10 }).growthPercent, STABLE_GROWTH_THRESHOLD);
  assert.equal(computeTrend({ value: "A", current: 11, previous: 10 }).trend, "rising");
  assert.equal(computeTrend({ value: "B", current: 9, previous: 10 }).growthPercent, -STABLE_GROWTH_THRESHOLD);
  assert.equal(computeTrend({ value: "B", current: 9, previous: 10 }).trend, "falling");
});

const authorRows: AuthorRecord[] = [
  { handle: "alice", tweet_id: "t1", posted_at: NOW - HOUR, entity_type: "TOKEN", entity_value: "BTC" },
  { handle: "alice", tweet_id: "t1", posted_at: NOW - HOUR, entity_type: "HASHTAG", entity_value: "crypto" },
  { handle: "alice", tweet_id: "t2", posted_at: NOW - 2 * HOUR, entity_type: "TOKEN", entity_value: "ETH" },
  { handle: "alice", tweet_id: "t2", posted_at: NOW - 2 * HOUR, entity_type: "TOKEN", entity_value: "BTC" },
  { handle: "bob", tweet_id: "t3", posted_at: NOW - 3 * HOUR }, // твит без сущностей
  { handle: "dave", tweet_id: "t5", posted_at: NOW - 6 * HOUR, entity_type: "TOKEN", entity_value: "SOL" },
  { handle: "carol", tweet_id: "t4", posted_at: NOW - 50 * HOUR, entity_type: "TOKEN", entity_value: "BTC" },
];

test("author ranking: топ авторов с количеством твитов/сущностей/токенов", () => {
  const top = aggregateAuthors(authorRows, { hours: 24 });
  assert.deepEqual(top.map((a) => a.handle), ["alice", "dave", "bob"]);

  const alice = top[0];
  assert.equal(alice.tweets, 2);
  assert.equal(alice.entities, 4);
  assert.equal(alice.tokens, 2); // BTC и ETH, повтор не считается

  const bob = top[2];
  assert.deepEqual(bob, { handle: "bob", tweets: 1, entities: 0, tokens: 0 });

  assert.equal(top.find((a) => a.handle === "carol"), undefined); // вне окна 24h
});

test("author ranking: сортировка tweets → entities → handle", () => {
  const ranked = rankAuthors([
    { handle: "zeta", tweets: 3, entities: 1, tokens: 1 },
    { handle: "alpha", tweets: 3, entities: 5, tokens: 2 },
    { handle: "mid", tweets: 7, entities: 0, tokens: 0 },
    { handle: "beta", tweets: 3, entities: 5, tokens: 2 },
  ]);
  assert.deepEqual(ranked.map((a) => a.handle), ["mid", "alpha", "beta", "zeta"]);
  assert.deepEqual(rankAuthors(ranked, 2).map((a) => a.handle), ["mid", "alpha"]);
  assert.deepEqual(aggregateAuthors([], { hours: 24 }), []);
});

test("author ranking: limit уменьшает выдачу", () => {
  assert.equal(aggregateAuthors(authorRows, { hours: 72, limit: 1 }).length, 1);
  assert.equal(aggregateAuthors(authorRows, { hours: 72, limit: 1 })[0].handle, "alice");
});
