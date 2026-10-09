import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateSignalScore, growthPercent, resolveLevel,
  type SignalInput,
} from "../src/intelligence/signals/scorer";
import { SIGNAL_CONFIG, totalWeight } from "../src/intelligence/signals/config";
import {
  applyAuthorInfluence, buildSignal, scoreEntities, type EntitySignalMetrics,
} from "../src/intelligence/signals/detector";

const HOURS = SIGNAL_CONFIG.windowHours;
const NOW = Date.now();

function input(over: Partial<SignalInput> = {}): SignalInput {
  return { entity: "BTC", currentMentions: 0, previousMentions: 0, uniqueAuthors: 0, velocity: 0, age: 24, ...over };
}

test("signals: формула — сумма факторов равна score, веса дают 100", () => {
  assert.equal(totalWeight(), 100);
  const s = calculateSignalScore(input({
    currentMentions: 7, previousMentions: 4, uniqueAuthors: 4, velocity: 0.5, age: 12,
  }));
  const sum = s.factors.frequency + s.factors.growth + s.factors.authors + s.factors.velocity;
  assert.equal(s.score, sum);
  assert.ok(s.score >= 0 && s.score <= 100);
  assert.deepEqual(s.factors, { frequency: 21, growth: 23, authors: 16, velocity: 10 });
  assert.equal(s.score, 70);
});

test("signals: low score → LOW", () => {
  const s = calculateSignalScore(input({
    currentMentions: 1, previousMentions: 1, uniqueAuthors: 1, velocity: 0.04, age: 24,
  }));
  assert.deepEqual(s.factors, { frequency: 3, growth: 0, authors: 4, velocity: 1 });
  assert.equal(s.score, 8);
  assert.equal(s.level, "LOW");
});

test("signals: high score → CRITICAL при максимальных факторах", () => {
  const s = calculateSignalScore(input({
    currentMentions: 10, previousMentions: 3, uniqueAuthors: 5, velocity: 1, age: 5,
  }));
  assert.deepEqual(s.factors, { frequency: 30, growth: 30, authors: 20, velocity: 20 });
  assert.equal(s.score, 100);
  assert.equal(s.level, "CRITICAL");
});

test("signals: growth calculation — рост к предыдущему периоду", () => {
  assert.equal(growthPercent(10, 5), 100);
  assert.equal(growthPercent(5, 10), -50);
  assert.equal(growthPercent(4, 4), 0);
  assert.equal(growthPercent(3, 0), 100); // новый всплеск, семантика Analytics v1
  assert.equal(growthPercent(0, 0), 0);

  const born = calculateSignalScore(input({ currentMentions: 5, previousMentions: 0 }));
  assert.equal(born.factors.growth, 30); // previous = 0 → полный growth

  const dying = calculateSignalScore(input({ currentMentions: 1, previousMentions: 10 }));
  assert.equal(dying.factors.growth, 0); // падение не даёт баллов
});

test("signals: level mapping — границы LOW/MEDIUM/HIGH/CRITICAL", () => {
  assert.equal(resolveLevel(0), "LOW");
  assert.equal(resolveLevel(49), "LOW");
  assert.equal(resolveLevel(50), "MEDIUM");
  assert.equal(resolveLevel(69), "MEDIUM");
  assert.equal(resolveLevel(70), "HIGH");
  assert.equal(resolveLevel(84), "HIGH");
  assert.equal(resolveLevel(85), "CRITICAL");
  assert.equal(resolveLevel(100), "CRITICAL");
  assert.equal(calculateSignalScore(input({ currentMentions: 50 })).level, "MEDIUM");
});

test("signals: age = 0 → velocity не считается доверенным", () => {
  const withAge = calculateSignalScore(input({ currentMentions: 4, age: 6, velocity: 1 }));
  const withoutAge = calculateSignalScore(input({ currentMentions: 4, age: 0, velocity: 1 }));
  assert.equal(withAge.factors.velocity, 20);
  assert.equal(withoutAge.factors.velocity, 0);
  assert.equal(withAge.score, withoutAge.score + 20);
});

test("signals: мусор на входе не роняет расчёт", () => {
  const s = calculateSignalScore(input({
    currentMentions: Number.NaN, previousMentions: -5, uniqueAuthors: Number.POSITIVE_INFINITY, velocity: -1, age: -1,
  }));
  assert.deepEqual(s.factors, { frequency: 0, growth: 0, authors: 0, velocity: 0 });
  assert.equal(s.score, 0);
  assert.equal(s.level, "LOW");
});

test("detector: метрики → сигнал с metadata", () => {
  const row: EntitySignalMetrics = {
    entityType: "TOKEN",
    value: "BTC",
    currentMentions: 8,
    previousMentions: 4,
    uniqueAuthors: 5,
    firstSeen: NOW - 6 * 3_600_000,
  };
  const signal = buildSignal(row, { hours: HOURS, now: NOW, minScore: 0, config: SIGNAL_CONFIG });
  assert.equal(signal.entity, "BTC");
  assert.equal(signal.metadata.entity_type, "TOKEN");
  assert.equal(signal.metadata.current_mentions, 8);
  assert.equal(signal.metadata.previous_mentions, 4);
  assert.equal(signal.metadata.window_hours, HOURS);
  assert.ok(Math.abs(signal.metadata.velocity - Math.round((8 / HOURS) * 1_000) / 1_000) < 1e-9);
  assert.ok(Math.abs(signal.metadata.age_hours - 6) < 0.01);
  assert.equal(signal.score, signal.factors.frequency + signal.factors.growth + signal.factors.authors + signal.factors.velocity);
});

test("detector: отсечка score >= minScore и сортировка по score DESC", () => {
  const rows: EntitySignalMetrics[] = [
    { entityType: "TOKEN", value: "WEAK", currentMentions: 1, previousMentions: 1, uniqueAuthors: 1, firstSeen: NOW - 3_600_000 },
    { entityType: "TOKEN", value: "STRONG", currentMentions: 10, previousMentions: 2, uniqueAuthors: 5, firstSeen: NOW - 3_600_000 },
    { entityType: "TOKEN", value: "MID", currentMentions: 4, previousMentions: 4, uniqueAuthors: 3, firstSeen: NOW - 3_600_000 },
  ];
  const opts = { hours: HOURS, now: NOW, minScore: 50, config: SIGNAL_CONFIG };
  const detected = scoreEntities(rows, opts);

  assert.deepEqual(detected.map((s) => s.entity), ["STRONG"]);
  assert.equal(detected[0].level, "CRITICAL");

  const all = scoreEntities(rows, { ...opts, minScore: 0 });
  assert.deepEqual(all.map((s) => s.entity), ["STRONG", "MID", "WEAK"]);
  assert.ok(all.every((s) => s.score >= 0));
  assert.deepEqual(scoreEntities([], opts), []);
});

test("signals + KOL: metadata kolDetected/authors/authorInfluence, score не меняется", () => {
  const opts = { hours: HOURS, now: NOW, minScore: 0, config: SIGNAL_CONFIG };
  const row: EntitySignalMetrics = {
    entityType: "TOKEN",
    value: "BTC",
    currentMentions: 10,
    previousMentions: 2,
    uniqueAuthors: 5,
    firstSeen: NOW - 3_600_000,
    authors: ["kol_top", "randomguy", "kol_mid"],
  };
  const signals = scoreEntities([row], opts);
  const before = { score: signals[0].score, factors: signals[0].factors };

  applyAuthorInfluence(
    signals,
    [row],
    new Map([["kol_top", 91], ["kol_mid", 70]]),
  );

  const annotated = signals[0];
  assert.equal(annotated.score, before.score); // score не изменился
  assert.deepEqual(annotated.factors, before.factors);
  assert.equal(annotated.metadata.kolDetected, true);
  assert.deepEqual(annotated.metadata.authors, ["kol_mid", "kol_top"]);
  assert.equal(annotated.authorInfluence, 91);
  assert.equal(annotated.metadata.authorInfluence, 91);

  const other: EntitySignalMetrics = {
    entityType: "TOKEN", value: "ETH", currentMentions: 3, previousMentions: 1,
    uniqueAuthors: 2, firstSeen: NOW - 3_600_000, authors: ["randomguy"],
  };
  const plain = scoreEntities([other], opts);
  applyAuthorInfluence(plain, [other], new Map([["kol_top", 91]]));
  assert.equal(plain[0].metadata.kolDetected, false);
  assert.deepEqual(plain[0].metadata.authors, []);
  assert.equal(plain[0].authorInfluence, undefined);
});
