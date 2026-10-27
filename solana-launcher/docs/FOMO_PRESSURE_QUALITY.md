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

The FOMO-specific evaluator is separate from the cross-platform \`attention_score\` backtest:
\`scripts/fomo-backtest.mjs\` compares recorded \`fomoPressure\` and \`fomoQuality\` values
against fixed-horizon price outcomes. It does not recalculate past FOMO values from
today's social data.

### Input format

Provide a UTF-8 JSONL file with one point-in-time record per token snapshot. Required fields:

- \`canonicalTokenId\`, \`signalAt\`, \`maxInputObservedAt\`, \`scoreVersion\`
- \`fomoPressure\` and \`fomoQuality\` in 0–100, \`qualityCoverage\` in 0–1
- \`signalCoverage.x\`, \`signalCoverage.tg\` equal to \`complete\`, and
  \`signalCoverage.knownAt\` no later than \`signalAt\`
- \`outcomeAt\`, \`outcomeObservedAt\`, \`outcomeEvidenceRef\`,
  \`forwardReturnPct\`, \`maxDrawdownPct\`
- \`outcomeCoverage.price=complete\` and \`outcomeCoverage.knownAt\` after the
  outcome horizon and no later than the data cutoff

\`maxInputObservedAt\` must be no later than \`signalAt\`. The outcome timestamp must
be within five minutes of the configured fixed horizon. \`maxDrawdownPct\` is signed
and non-positive (for example, \`-18.5\` means an 18.5% drawdown).

Example record shape (illustrative only, not real project data):

\`\`\`json
{
  "canonicalTokenId": "example-token-id",
  "signalAt": "2025-01-01T00:00:00.000Z",
  "maxInputObservedAt": "2025-01-01T00:00:00.000Z",
  "scoreVersion": "fomo-pressure-quality-v1",
  "fomoPressure": 82,
  "fomoQuality": 61,
  "qualityCoverage": 1,
  "signalCoverage": {
    "x": "complete",
    "tg": "complete",
    "knownAt": "2025-01-01T00:00:00.000Z"
  },
  "outcomeAt": "2025-01-02T00:00:00.000Z",
  "outcomeObservedAt": "2025-01-02T00:01:00.000Z",
  "outcomeEvidenceRef": "price-candle-reference",
  "forwardReturnPct": 12.4,
  "maxDrawdownPct": -8.1,
  "outcomeCoverage": {
    "price": "complete",
    "knownAt": "2025-01-02T00:01:00.000Z"
  }
}
\`\`\`

Run after collecting real point-in-time score snapshots and matured outcomes:

\`\`\`sh
npm run fomo:backtest -- --input ./data/fomo-snapshots.jsonl --from 2025-01-01 --to 2025-06-30 --cutoff-at 2025-07-02T00:00:00Z --horizon-hours 24 --pressure-threshold 70 --quality-threshold 60 --min-quality-coverage 0.75 --target-return-pct 10 --adverse-drawdown-pct -20 --output ./data/fomo-backtest-report.json
\`\`\`

The report contains sample/coverage counts, mean and median forward returns, positive-return
and target-hit rates, adverse-drawdown rates, and Spearman rank correlations for both scores.
It also compares high-pressure observations with high- and low-quality subgroups. The
runner selects the latest snapshot per token/UTC day, rejects mixed score versions, requires
complete source and price coverage, and fails closed on look-ahead or incomplete outcomes.
It does not emit row-level token data, p-values, or independent-sample confidence intervals.

**Current data limitation:** the UI's FOMO scores are calculated from live social inputs.
This PR adds the evaluator and tests, not a historical score-capture pipeline. A real
backtest cannot run until point-in-time FOMO scores and their matching matured price
outcomes have actually been stored/exported. Never pair current scores with past prices.
