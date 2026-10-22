import test from "node:test";
import assert from "node:assert/strict";
import { formatTokenId } from "@claude-project/contracts";
import { runSignalBacktest } from "../dist/index.js";

const token = formatTokenId("solana", "So11111111111111111111111111111111111111112");
function row(index, score, outcome) {
  const signalAt = `2026-10-01T0${index}:00:00Z`;
  return {
    canonicalTokenId: token, signalAt,
    maxInputObservedAt: new Date(Date.parse(signalAt) - 60_000).toISOString(),
    outcomeAt: new Date(Date.parse(signalAt) + 60 * 60_000).toISOString(),
    outcomeObservedAt: new Date(Date.parse(signalAt) + 61 * 60_000).toISOString(),
    score, outcome,
  };
}

test("backtest computes precision, recall, uplift and confidence bounds", () => {
  const result = runSignalBacktest([
    row(1, 0.9, true), row(2, 0.8, true), row(3, 0.7, false),
    row(4, 0.2, false), row(5, 0.1, true), row(6, 0.1, false),
  ], { threshold: 0.7 });
  assert.equal(result.metrics.sampleSize, 6);
  assert.equal(result.metrics.selectedCount, 3);
  assert.equal(result.metrics.precision, 2 / 3);
  assert.equal(result.metrics.recall, 2 / 3);
  assert.equal(result.metrics.baselineCount, 6);
  assert.equal(result.metrics.baselineRate, 0.5);
  assert.ok(Math.abs(result.metrics.uplift - 1 / 6) < 1e-12);
  assert.ok(result.metrics.ciLow <= result.metrics.uplift);
  assert.ok(result.metrics.ciHigh >= result.metrics.uplift);
  assert.ok(result.metrics.pValue >= 0 && result.metrics.pValue <= 1);
});

test("backtest rejects look-ahead, noncanonical IDs and non-future outcomes", () => {
  assert.throws(() => runSignalBacktest([{
    ...row(1, 0.9, true), maxInputObservedAt: "2026-10-01T02:00:00Z",
  }], { threshold: 0.5 }), /Look-ahead/);
  assert.throws(() => runSignalBacktest([{ ...row(1, 0.9, true), canonicalTokenId: "solana:fake" }], { threshold: 0.5 }), /Noncanonical/);
  assert.throws(() => runSignalBacktest([{ ...row(1, 0.9, true), outcomeAt: "2026-10-01T01:00:00Z" }], { threshold: 0.5 }), /Outcome must occur after/);
});

test("perfect separation with a tiny sample does not report zero uncertainty or p-value", () => {
  const result = runSignalBacktest([row(1,1,true),row(2,1,true),row(3,0,false),row(4,0,false)],{threshold:0.5});
  assert.equal(result.metrics.baselineRate,0.5); assert.equal(result.metrics.uplift,0.5);
  assert.ok(result.metrics.ciLow<result.metrics.uplift); assert.ok(result.metrics.ciHigh>=result.metrics.uplift);
  assert.ok(result.metrics.pValue>0&&result.metrics.pValue<=1);
});

test("random baseline is deterministic for a fixed seed", () => {
  const rows = [row(1, 0.9, true), row(2, 0.8, false), row(3, 0.1, false), row(4, 0.2, true)];
  const a = runSignalBacktest(rows, { threshold: 0.8, baseline: "random", seed: "fixed" });
  const b = runSignalBacktest(rows, { threshold: 0.8, baseline: "random", seed: "fixed" });
  assert.deepEqual(a.metrics, b.metrics);
});
