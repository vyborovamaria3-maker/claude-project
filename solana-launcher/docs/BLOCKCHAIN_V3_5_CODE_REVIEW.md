# Blockchain Analytics V3.5 — Adversarial Code Review

## Scope

Reviewed the new temporal replay layer plus its integration through `quality.ts`, `analyze.ts`, `provider.ts`, and `db.ts`, with V3.4.1 as the regression baseline.

## Defects found and fixed during implementation

1. **Union-find root-link bug** — the first cluster implementation could fail to union when the lexicographically smaller root was on the right side. Fixed by explicitly attaching the larger root to the smaller root. A deterministic funding-cluster regression now covers it.

2. **Holder-series variable shadowing** — `analyze.ts` initially shadowed the provider `holderCountSeries` with the derived count-only series. Targeted integration TypeScript caught it; provider series and derived series now have distinct names.

3. **Stale wallet mark used for unrealized PnL** — wallet-specific last trade is not a valid current mark. Production now derives one global comparable mark across the token's trades and rejects marks older than 15 minutes.

4. **Incomplete history could imply total PnL** — FIFO replay over a partial history can silently miss pre-existing inventory. Authoritative PnL now requires both complete launch history and no unmatched sells. Partial-history inventory remains diagnostic only.

5. **Mixed quote cost basis** — quote assets cannot share one FIFO ledger unless every row has a common USD notional. Mixed non-USD ledgers are unavailable instead of being combined.

6. **Dense polling inflated backtest sample size** — overlapping forward-return intervals are autocorrelated. V3.5 keeps raw observations for visibility but computes statistics from non-overlapping anchors.

7. **Cohort naming ambiguity** — available data proves wallet age, not token acquisition time. Cohort snapshots now explicitly expose `basis = wallet_first_seen`, sampled supply, unobserved supply, and holder-set completeness.

8. **Temporal future-row leakage** — persisted rows with timestamps after the analysis time are filtered out before cohort/replay analysis.

9. **Coactivity O(N^2) risk** — repeated-wallet pair construction is capped to the 80 most active wallets per 15m bucket before pair expansion.

10. **Persistence overcount from repeated UI polls** — temporal anchors use one minute bucket per mint; cluster observation counts increment at most once per minute.

## Semantics intentionally kept conservative

- repeated coactivity is not called insider trading;
- shared funding is not ownership proof;
- correlation is descriptive calibration, not causal proof;
- fewer than five paired samples produce null correlation;
- stale/missing marks produce null open-position PnL;
- unknown age remains an explicit cohort;
- missing USD conversion blocks liquidity-normalized custom-quote flow.

## Remaining limitations

- Wallet-age cohorts are not acquisition-time cohorts. True holder-tenure migration would require historical owner balances or transfer-derived acquisition timestamps.
- FIFO cost basis assumes the normalized launch history represents economic buys/sells correctly; transfer-in inventory still requires a richer inventory provenance ledger before total PnL can be proven in every wallet.
- Outcome replay is per-token local calibration. Cross-token model calibration and regime stratification are not part of V3.5.
- SQLite runtime behavior was not exercised against a native `better-sqlite3` binary in this execution environment; schema/persistence code is covered by strict integration typechecking and static SQL review.

## Recommended V3.6 direction

The next meaningful step is cross-token calibration: persist outcome labels across mints, stratify by launch/liquidity/lifecycle regime, compute precision/recall for discrete risk events, and use walk-forward splits so thresholds are tuned only on past tokens.
