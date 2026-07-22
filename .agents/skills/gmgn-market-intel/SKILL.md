---
name: gmgn-market-intel
description: Narrow GMGN skill for market discovery, trending tokens, hot searches, trenches, signals, and market ranking analysis.
---

# GMGN Market Intel

## Purpose

Use this skill for market-first analysis:

- trending tokens
- Pump.fun trending tokens
- hot searches
- new or migrated tokens
- near-completion tokens
- market signals

## Workflow

1. Start with `gmgn-cli market ...`
2. Apply chain and interval presets
3. Add market-cap and liquidity filters if ranking candidates
4. Return list view first, then a short shortlist

## Suggested commands

- `node scripts/gmgn-market.mjs trending`
- `node scripts/gmgn-market.mjs hot-searches`
- `node scripts/gmgn-market.mjs trenches-new`
- `node scripts/gmgn-market.mjs trenches-completed`
- `node scripts/gmgn-market.mjs trenches-near-completion`
- `node scripts/gmgn-market.mjs signals`

## Output shape

Return:

1. ranked list
2. top candidates
3. why they rank
4. key risks

## References

Read [references/output-templates.md](references/output-templates.md) for table and JSON layout.
Read [references/analysis-params.md](references/analysis-params.md) for the standard market presets.

