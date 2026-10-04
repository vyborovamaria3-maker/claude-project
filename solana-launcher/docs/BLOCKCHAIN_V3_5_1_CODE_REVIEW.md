# Blockchain Analytics V3.5.1 — Adversarial Code Review

Date: 2026-09-23
Reviewed baseline: V3.5 Temporal / On-chain Replay

## Executive summary

The V3.5 architecture is directionally sound: pure-CPU temporal analytics, explicit evidence coverage, local persistence, and forward outcome replay are good foundations. However, adversarial review found several production-impacting defects that the 240-snapshot benchmark and existing 28 regression cases did not expose.

This review fixes seven concrete defects and preserves the evidence rule `unknown != 0 != safe`.

## Fixed findings

### P1 — FIFO PnL completeness used the wrong evidence flag

`analyzeChainQualityV3()` passed `launchHistory.complete` into `computeCostBasisLedgers()`.

That flag proves only that the first launch window (roughly the first 100 slots) was parsed. It does **not** prove that the middle of the token's history is covered. On an active token, recent enhanced history can be truncated at 600 transactions while launch history is still complete, producing a gap between launch and recent history.

Impact: the ledger could emit authoritative realized/unrealized PnL over a discontinuous trade history.

Fix: authoritative trade-ledger completeness now uses `recentTrades.complete`, which is set only when the newest-first enhanced-history fetch exhausts all pages.

Important remaining limitation: even an exhausted trade history does not prove complete token-transfer inventory provenance. V3.5.1 PnL remains a trade-ledger estimate, not full wallet accounting.

### P1 — Temporal cluster persistence included stale launch activity

`computeWalletClusterPersistence()` accepted `nowSec` but did not use it. Coactivity was calculated over all trades, including old launch trades, while the persistence denominator was capped at six hours.

Impact: a cluster active only at launch could receive `persistence01 = 1` long after it stopped being active.

Fix: temporal coactivity is now restricted to the currently evidenced recent window, capped at 6h. Unknown recent coverage disables coactivity evidence instead of treating stale launch activity as current.

### P1 — Temporal history query returned the oldest limited rows

`listChainTemporalSnapshots()` used `ORDER BY observed_at ASC LIMIT 5000`.

At one persisted snapshot/minute, seven days can contain ~10,080 rows. The query therefore returned the oldest part of the retention window and silently dropped the newest several days.

Impact: outcome calibration could miss the most relevant recent labels and leave a large gap before the current snapshot.

Fix: SQL now limits newest rows first (`DESC`), then returns them chronologically. Default capacity is 12,000; provider requests 10,500 rows for a seven-day minute-level window.

### P1 — Outcome replay target lookup was O(N^2)

For every anchor and horizon, `nearestTarget()` rescanned the full temporal history.

Measured warm median before fix:
- 5,000 snapshots: ~259.3 ms

Fix: history remains sorted and target lookup now uses binary-search lower bound (`O(log N)` per anchor).

Measured warm medians after fix:
- 5,000 snapshots: ~8.4 ms
- 10,000 snapshots: ~14.7 ms

### P2 — Temporal wallet ranking was polluted by old launch activity

Wallets were ranked by total trade count before individual windows were applied. A wallet with many launch trades could displace a currently active wallet from the top-N temporal analysis.

Fix: ranking input is now restricted to the maximum temporal horizon (6h) and excludes future rows.

### P2 — Future-dated trades could contaminate FIFO inventory

The mark price was rejected if the latest trade was in the future, but the future trade itself could still enter FIFO inventory/proceeds.

Fix: when `nowSec` is supplied, cost-basis grouping and mark derivation both exclude rows after `nowSec + 1s`.

### P2 — Malformed schema-v1 temporal payload could poison replay

Persistence only validated `schemaVersion` and `observedAt`. A row with `signals: null` could reach outcome replay and throw while dereferencing signal fields. Malformed cohort payloads had a similar nested access risk.

Fix: signal reads are null-safe and cohort delta nested access is defensive. Corrupt partial rows degrade to unavailable signal evidence instead of disabling the whole quality bundle.

## Additional hardening

Forward-window de-overlap now tracks the actual selected target timestamp rather than only nominal anchor spacing. This makes the independence rule explicit even when horizon tolerance selects an early/late target.

## Regression / compatibility

- V3.5/V3.5.1 temporal regressions: 32 passed, 0 failed.
- V3.4 backward-compatibility regressions: 32 passed, 0 failed.
- Total deterministic checks: 64 passed, 0 failed.
- Targeted blockchain integration TypeScript: PASS.

## Performance

Full synthetic V3.5 workload:
- 3,200 trades
- 60 wallets/holders
- 20 verified funding edges
- 240 temporal snapshots
- 50 measured loops

Average: 4.773 ms (budget <20 ms)

Production-scale replay:
- 10,000 temporal snapshots
- benchmark run: 17.407 ms
- warm median across repeated comparison runs: 14.689 ms
- budget: <20 ms

## Remaining architectural limitations (not silently “fixed”)

### 1. Trade history != complete inventory provenance

Pure token transfers, airdrops, custody moves, and transfers between owned wallets can change inventory without appearing as buys/sells. Therefore FIFO PnL is still a trade-ledger estimate. A future version should ingest token balance deltas / transfer provenance before presenting full wallet-accounting PnL.

### 2. Verified funding != common control

The cluster graph can connect wallets through a verified shared funder. A verified transfer proves funding provenance, not ownership or coordination. Exchange/ramp/service wallets can fund unrelated users. Cluster UI/scoring must retain `source=verified_funding` and must not relabel this as insider ownership without additional evidence.

### 3. Wallet-age cohort “migration” includes natural aging

Cohorts use wallet `firstSeen`, not token acquisition time. A holder can move from `<24h` to `1-7d` purely because time passed, even if the holder set did not change. The metric is useful as wallet-age composition, but it is not a pure token-holder migration measure.

### 4. Calibration is descriptive, not regime-aware prediction

Pearson/Spearman, mean and median returns are useful diagnostics, but current V3.5 replay does not stratify by liquidity, lifecycle, token age, volatility, launch venue, or market regime. Cross-token walk-forward calibration belongs in V3.6.

## Recommendation

V3.5.1 is materially safer than V3.5 for production temporal replay. The remaining limitations should be preserved explicitly in API/UI semantics rather than converted into numeric certainty.
