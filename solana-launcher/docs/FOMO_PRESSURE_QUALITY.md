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
