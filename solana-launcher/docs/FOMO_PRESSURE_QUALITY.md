# FOMO Pressure and FOMO Quality

## Purpose

The existing `FOMO score` is preserved unchanged and exposed as `FOMO Pressure`.
Pressure measures heuristic attention intensity; it is not a probability of price
appreciation or a trading signal.

`FOMO Quality` is an additional deterministic heuristic intended to describe how
credible and diversified the observed attention looks. It is not a probability,
a guarantee that manipulation is absent, or a substitute for market-risk checks.

## FOMO Pressure (legacy formula)

The existing formula remains:

- Hype: weight 0.55
- Positive sentiment: weight 0.25 (the existing maximum of available X/TG positive shares)
- Telegram call density: weight 0.20 when Telegram is available

The shared `weightedScore` helper renormalizes over available components. The legacy
`FOMO score` table row remains available for compatibility and should equal
`FOMO Pressure`.

## FOMO Quality (new heuristic)

The score is a coverage-aware weighted combination of existing metrics:

- Organic score: 0.45
- Inverse manipulation score (100 - manipulation): 0.25
- Cross-platform temporal alignment: 0.15 when both platforms have timestamped events
- X author diversity: 0.075 when X has mentions
- Telegram source diffusion: 0.075 when Telegram has mentions

Missing components are omitted and remaining weights are renormalized. A 0.25
coverage penalty is applied by `weightedScore`, and the separate coverage value is
the share of configured component weight that had usable input. That value is not
the proportion of all posts or accounts observed.

## Caveats

- These are heuristics, not probabilities or investment advice.
- Organicity, manipulation, copy ratio, and author/source diversity share some
  underlying inputs; Quality is intentionally a composite indicator, not a
  statistically independent signal.
- Missing or sampled data can change both the score and its coverage.
- Backtesting against timestamp-correct historical data is required before using
  either score as a predictive feature.
- The legacy Pressure formula is not recalibrated in this change.


## FOMO Pressure / Quality historical evaluation

The FOMO-specific evaluator is separate from the cross-platform `attention_score` backtest:
`scripts/fomo-backtest.mjs` compares recorded point-in-time `fomoPressure` and `fomoQuality` values
against fixed-horizon price outcomes. It never recalculates past FOMO values from today's social data.

### Snapshot capture

The Social Intelligence UI now triggers `POST /api/trade/fomo-snapshot` after both X and Telegram responses are available.
The route fetches the canonical source responses server-side, computes scores server-side at a fixed `signalAt`,
and stores snapshots in the local `data/trade.db` SQLite database. The browser submits only the mint, not scores.
Capture attempts (including failures) are recorded separately. A unique 15-minute token/version bucket prevents duplicate
captures and preserves the first snapshot in that bucket.

The capture uses a fixed query configuration (24-hour lookback, bounded X sample of up to 40 posts, Telegram timeline
limit 200) so scores remain comparable across UI filter changes. Bump `FOMO_SCORE_VERSION` in
`lib/trade/fomo-snapshot.ts` when the formula or capture query configuration changes.

For each snapshot the database stores the FOMO Pressure and Quality scores, Quality component coverage, score version,
signal time, maximum input-observed time, per-source sample counts, truncation/cache flags, source response timestamps,
source-response SHA-256 hashes, a combined input hash, a snapshot hash, and bounded metadata. Raw tweet/message bodies
are not persisted by this capture feature. Future-dated social events are rejected.

**X and Telegram coverage is always labelled partial** because the current APIs return bounded/filtered samples rather than
proof of exhaustive platform history. "Not truncated" does not mean "complete coverage." Unknown source coverage is rejected
by the evaluator; explicitly partial coverage can be evaluated but must be reported as sample-conditional, not population-wide.

### Exporting captured snapshots

From `solana-launcher`, export the signal history:

~~~sh
npm run fomo:snapshots:export -- --from 2026-10-27 --to 2026-12-31 --output ./data/fomo-snapshots.jsonl
~~~

The export includes the snapshot/source hashes, score version, as-of timestamps, coverage flags, and source metadata, but leaves
price outcomes null. **It is not directly backtest-ready** until a separate price-outcome joiner supplies a fixed-horizon return,
drawdown, evidence reference, and verified outcome coverage. The current token-trade cache does not by itself prove continuous
price coverage, so missing candles must not be treated as zero returns or as a complete outcome.

### Joining price outcomes

Start the local Next.js app with real provider credentials/configuration (the joiner rejects mock candles), then run:

~~~sh
npm run fomo:price-join -- \
  --input ./data/fomo-snapshots.jsonl \
  --output ./data/fomo-labelled.jsonl \
  --evidence-output ./data/fomo-price-evidence.jsonl \
  --audit-output ./data/fomo-price-join-audit.json \
  --horizon-hours 24
~~~

The joiner calls the local `/api/token-history` route using deep 5-minute candles by default. Use
`--base-url http://127.0.0.1:3000` if the app is served elsewhere, or `--timeframe 1m` for finer candles.
Only supported non-mock sources are accepted. It uses the first complete candle open at or after the signal (maximum
5-minute entry delay), then the nearest complete candle close to `signalAt + horizon` (maximum 5-minute offset).
Every candle between entry and exit must be present at the chosen interval. Gaps are excluded; prices are never interpolated,
and missing candles are never treated as zero returns.

The labelled output contains **only rows with a matured horizon and complete contiguous price bars**. All excluded snapshots
and reason codes are recorded in the audit JSON. The evidence JSONL stores the returned price candles, source, retrieval time,
timeframe, and a SHA-256 evidence hash; keep this file with the labelled output. `outcomeObservedAt` and
`outcomeCoverage.knownAt` record when this join run observed and validated the prices, not when the historical
trades originally happened. The audit report's `cutoffAt` is the dataset cutoff to pass to the backtest.

Example backtest using the cutoff recorded in the audit report:

~~~sh
npm run fomo:backtest -- \
  --input ./data/fomo-labelled.jsonl \
  --from 2026-10-27 --to 2026-12-31 \
  --cutoff-at 2026-12-31T23:59:59.000Z \
  --horizon-hours 24
~~~

Replace the example cutoff and dates with values from your actual join report and dataset. The joiner's OHLC drawdown estimate is
conservative: within each candle it assumes the high happened before the low. This is not tick-level path reconstruction, and
a contiguous provider response is evidence of continuity only for the labelled interval, not proof of completeness outside it.

### Backtest contract

The JSONL evaluator requires `canonicalTokenId`, `signalAt`, `maxInputObservedAt`,
`scoreVersion`, both scores, and source-coverage status/known-at time, plus a matured fixed-horizon price outcome.
`maxInputObservedAt` must be no later than `signalAt`. Outcome timestamp must be within five minutes of the
configured horizon; the outcome must have been observed and its price coverage known by the configured cutoff. Unknown source
coverage and incomplete outcome labels fail closed.

Reports include mean/median forward returns, positive-return and target-hit rates, adverse-drawdown rates, cohort comparisons,
and Spearman rank correlations. Repeated observations for the same token can be dependent; no naive p-values or independent-sample
confidence intervals are reported. Partial source coverage can bias the captured sample and must remain visible in interpretation.

**Data limitation:** snapshots begin accumulating only when this branch/version is running and tokens are analyzed in the UI. This
does not reconstruct historical FOMO scores. Do not pair current scores with past prices, and do not claim predictive performance
until enough point-in-time snapshots have matured and have matching price outcomes with defensible coverage.
