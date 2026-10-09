import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTHOR_CONFIG, totalWeight } from "../src/intelligence/authors/config";
import {
  activityScoreFor, metricsFromRow, type AuthorMetrics,
} from "../src/intelligence/authors/metrics";
import {
  calculateInfluenceScore, resolveAuthorLevel, selectKOLs, type AuthorInfluence,
} from "../src/intelligence/authors/scorer";
import { metrics } from "../src/core/metrics";

function author(over: Partial<AuthorMetrics> = {}): AuthorMetrics {
  return {
    handle: "alice",
    tweets: 0,
    entities: 0,
    tokens: 0,
    uniqueEntities: 0,
    activeDays: 0,
    avgEngagement: 0,
    activityScore: 0,
    ...over,
  };
}

function influence(handle: string, score: number): AuthorInfluence {
  return { handle, score, level: resolveAuthorLevel(score), factors: { activity: 0, entityQuality: 0, consistency: 0, engagement: 0 } };
}

test("author metrics: агрегат строки → метрики", () => {
  const m = metricsFromRow({
    handle: "alice",
    tweets: 10,
    entities: 30,
    tokens: 5,
    unique_entities: 12,
    active_days: 4,
    engagement_sum: 200,
  });
  assert.deepEqual(m, {
    handle: "alice",
    tweets: 10,
    entities: 30,
    tokens: 5,
    uniqueEntities: 12,
    activeDays: 4,
    avgEngagement: 20,
    activityScore: 50,
  });

  const zero = metricsFromRow({
    handle: "bob", tweets: 0, entities: 0, tokens: 0, unique_entities: 0, active_days: 0, engagement_sum: 0,
  });
  assert.equal(zero.avgEngagement, 0);
  assert.equal(zero.activityScore, 0);
});

test("author metrics: activityScore — нормировка 0..100", () => {
  assert.equal(activityScoreFor(0), 0);
  assert.equal(activityScoreFor(1), 5);
  assert.equal(activityScoreFor(10), 50);
  assert.equal(activityScoreFor(20), 100);
  assert.equal(activityScoreFor(500), 100);
});

test("influence: веса 25×4 = 100, score = сумма факторов", () => {
  assert.equal(totalWeight(), 100);
  const r = calculateInfluenceScore(author({
    tweets: 5, entities: 12, tokens: 2, uniqueEntities: 5, activeDays: 3, avgEngagement: 2,
    activityScore: 25,
  }));
  const sum = r.factors.activity + r.factors.entityQuality + r.factors.consistency + r.factors.engagement;
  assert.equal(r.score, sum);
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.equal(r.level, resolveAuthorLevel(r.score));
});

test("influence: low author → LOW", () => {
  const r = calculateInfluenceScore(author({
    tweets: 1, entities: 1, tokens: 0, uniqueEntities: 1, activeDays: 1, avgEngagement: 0, activityScore: 5,
  }));
  assert.deepEqual(r.factors, { activity: 1, entityQuality: 1, consistency: 4, engagement: 0 });
  assert.equal(r.score, 6);
  assert.equal(r.level, "LOW");
});

test("influence: high author → KOL", () => {
  const r = calculateInfluenceScore(author({
    tweets: 50, entities: 120, tokens: 8, uniqueEntities: 20, activeDays: 14, avgEngagement: 40, activityScore: 100,
  }));
  assert.deepEqual(r.factors, { activity: 25, entityQuality: 25, consistency: 25, engagement: 25 });
  assert.equal(r.score, 100);
  assert.equal(r.level, "KOL");
});

test("influence: level mapping — 0-30 LOW / 31-60 MEDIUM / 61-80 HIGH / 81-100 KOL", () => {
  assert.equal(resolveAuthorLevel(0), "LOW");
  assert.equal(resolveAuthorLevel(30), "LOW");
  assert.equal(resolveAuthorLevel(31), "MEDIUM");
  assert.equal(resolveAuthorLevel(60), "MEDIUM");
  assert.equal(resolveAuthorLevel(61), "HIGH");
  assert.equal(resolveAuthorLevel(80), "HIGH");
  assert.equal(resolveAuthorLevel(81), "KOL");
  assert.equal(resolveAuthorLevel(100), "KOL");
});

test("config: веса 25×4, границы уровней и порог детектора", () => {
  const f = AUTHOR_CONFIG.factors;
  assert.equal(f.activity.weight, 25);
  assert.equal(f.entityQuality.weight, 25);
  assert.equal(f.consistency.weight, 25);
  assert.equal(f.engagement.weight, 25);
  assert.deepEqual(AUTHOR_CONFIG.levels, { medium: 31, high: 61, kol: 81 });
  assert.equal(AUTHOR_CONFIG.minScoreToDetect, 60);
});

test("KOL threshold: score >= 60, сортировка по score DESC", () => {
  const rows = [influence("a", 59), influence("b", 61), influence("c", 100), influence("d", 60)];
  assert.deepEqual(selectKOLs(rows).map((r) => r.handle), ["c", "b", "d"]);
  assert.deepEqual(selectKOLs(rows, 80).map((r) => r.handle), ["c"]);
  assert.deepEqual(selectKOLs(rows, 101), []);
  assert.deepEqual(selectKOLs([]), []);
});

test("metrics: authorsAnalyzed растёт на каждый расчёт", () => {
  const before = metrics.authorsAnalyzed;
  calculateInfluenceScore(author({ tweets: 1 }));
  calculateInfluenceScore(author({ tweets: 2 }));
  assert.equal(metrics.authorsAnalyzed, before + 2);
});
