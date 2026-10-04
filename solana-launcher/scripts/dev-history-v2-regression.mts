import assert from "node:assert/strict";
import { computeDevHistoryAnalytics } from "../lib/trade/dev-history.ts";

const now = 1_800_000_000;
const mk = (i: number, extra: Record<string, unknown> = {}) => ({
  mint: `M${i}`,
  symbol: `T${i}`,
  name: `Token ${i}`,
  createdAt: 1_700_000_000 + i * 3600,
  marketCapUsd: 10_000,
  athUsd: 20_000,
  isMigrated: false,
  reached300k: false,
  ...extra,
});

{
  const out = computeDevHistoryAnalytics({ tokens: [mk(1), mk(2, { athUsd: 2_000_000 })], currentMint: "M2", nowSec: now });
  assert.equal(out.previousLaunches, 1);
  assert.equal(out.ath.maxUsd, 20_000);
}
{
  const out = computeDevHistoryAnalytics({ tokens: [mk(1, { athUsd: null }), mk(2, { athUsd: 120_000 })], nowSec: now });
  assert.equal(out.thresholds.reached100k.observedCount, 1);
  assert.equal(out.thresholds.reached100k.rate, 1);
}
{
  const out = computeDevHistoryAnalytics({ tokens: [mk(1, { athUsd: null, reached300k: true })], nowSec: now });
  assert.equal(out.thresholds.reached300k.rate, 1);
  assert.equal(out.thresholds.reached1m.rate, null);
}
{
  const out = computeDevHistoryAnalytics({
    tokens: [10_000, 50_000, 150_000, 500_000, 2_000_000].map((ath, i) => mk(i, { athUsd: ath })).concat([mk(9, { athUsd: null })]),
    nowSec: now,
  });
  assert.deepEqual(out.distribution.map((row) => row.count), [1, 1, 1, 1, 1]);
  assert.equal(out.ath.observedCount, 5);
}
{
  const tokens = Array.from({ length: 20 }, (_, i) => mk(i, {
    createdAt: 1_700_000_000 + i * 3600,
    athUsd: i >= 10 ? 500_000 : 20_000,
  }));
  const out = computeDevHistoryAnalytics({ tokens, nowSec: now });
  assert.equal(out.trend.state, "improving");
}
{
  const out = computeDevHistoryAnalytics({
    tokens: [mk(1), mk(2), mk(3), mk(4)],
    recurringCoveredTokens: 2,
    recurringWallets: [{ wallet: "W", tokenCount: 2, tradeCount: 4, volumeSol: 12, firstSeen: 10, lastSeen: 20 }],
    nowSec: now,
  });
  assert.equal(out.recurringNetwork.coverage, 0.5);
}

{
  const out = computeDevHistoryAnalytics({ tokens: [mk(1, { athUsd: 50_000, reached300k: true })], nowSec: now });
  assert.equal(out.thresholds.reached300k.rate, 1);
  assert.equal(out.ath.observedCount, 0);
}

{
  const tokens = Array.from({ length: 20 }, (_, i) => mk(i, {
    createdAt: 1_700_000_000 + i * 3600,
    athUsd: i >= 10 ? (i < 16 ? 500_000 : 20_000) : 100_000,
  }));
  const out = computeDevHistoryAnalytics({ tokens, nowSec: now });
  assert.equal(out.trend.state, "unknown");
}

console.log("DEV_HISTORY_V2_REGRESSION=PASS 8/8");
