import test from "node:test";
import assert from "node:assert/strict";
import { formatTokenId } from "@claude-project/contracts";
import { runSignalBacktest, persistBacktestRun } from "../dist/index.js";

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
  assert.equal(result.metrics.ciLow,null);
  assert.equal(result.metrics.ciHigh,null);
  assert.equal(result.metrics.pValue,null,"repeated tokens are not independent");
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
  assert.equal(result.metrics.ciLow,null); assert.equal(result.metrics.ciHigh,null);
  assert.equal(result.metrics.pValue,null,"repeated token cohorts cannot claim significance");
});

test("random baseline is deterministic for a fixed seed", () => {
  const rows = [row(1, 0.9, true), row(2, 0.8, false), row(3, 0.1, false), row(4, 0.2, true)];
  const a = runSignalBacktest(rows, { threshold: 0.8, baseline: "random", seed: "fixed" });
  const b = runSignalBacktest(rows, { threshold: 0.8, baseline: "random", seed: "fixed" });
  assert.deepEqual(a.metrics, b.metrics);
});

test("random baseline samples the full cohort and never invents independent p-values",()=>{
  const observations=[row(1,0.9,true),row(2,0.8,false),row(3,0.1,false),row(4,0.2,true)];
  const result=runSignalBacktest(observations,{threshold:0.8,baseline:"random",seed:"fixed"});
  assert.equal(result.metrics.baselineCount,2);
  assert.equal(result.metrics.ciLow,null); assert.equal(result.metrics.pValue,null);
});

test("CLI includes incomplete horizons and missing labels rather than dropping them",async()=>{
  const {readFile}=await import("node:fs/promises");
  const sql=await readFile(new URL("../scripts/backtest.mjs",import.meta.url),"utf8");
  assert.match(sql,/LEFT JOIN LATERAL/);
  assert.match(sql,/horizon_complete/);
  assert.match(sql,/backtest_incomplete_horizon/);
  assert.match(sql,/backtest_incomplete_outcome_coverage/);
  assert.match(sql,/completedHorizonCount/);
  assert.match(sql,/missingOutcomeCount/);
  assert.match(sql,/outcome_match_count/);
  assert.match(sql,/backtest_ambiguous_outcome_labels/);
});

test("persistence refuses signals whose horizon or outcome observation exceeds cutoff",async()=>{
  const run=runSignalBacktest([row(1,0.9,true)],{threshold:0.5});
  let called=false;
  const tx={async query(){called=true;throw new Error("unexpected database write")}};
  const input={runId:run.runId,signalName:"attention_score",outcomeKind:"price_2x_24h",
    fromAt:"2026-10-01T00:00:00Z",toAt:"2026-10-01T01:30:00Z",
    horizonHours:2,threshold:0.5,baselineKind:"market_average",metrics:run.metrics,
    observations:run.observations,dataCutoffAt:"2026-10-01T02:45:00Z"};
  await assert.rejects(persistBacktestRun(tx,input),/as-of or completed-horizon/);
  await assert.rejects(persistBacktestRun(tx,{...input,horizonHours:1,
    dataCutoffAt:"2026-10-01T03:00:00Z",observations:[{...run.observations[0],
      outcomeObservedAt:"2026-10-01T03:01:00Z"}]}),/as-of or completed-horizon/);
  assert.equal(called,false);
});

test("small independent cohorts have no invented confidence interval or p-value",()=>{
  // Two distinct canonical public Solana IDs rather than repeat observations
  // for one mint; even distinct small groups are insufficient for significance.
  const other=formatTokenId("solana","11111111111111111111111111111111");
  const result=runSignalBacktest([
    row(1,0.9,true),{...row(2,0.1,false),canonicalTokenId:other},
  ],{threshold:0.5});
  assert.equal(result.metrics.pValue,null);
  assert.equal(result.metrics.ciLow,null);
  assert.equal(result.metrics.ciHigh,null);
});
