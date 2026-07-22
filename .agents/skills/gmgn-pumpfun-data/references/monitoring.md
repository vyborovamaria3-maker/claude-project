# Monitoring

## Goal

Track new Pump.fun tokens and surface changes that matter.

## Monitoring loop

1. Poll the discovery or trending source on a schedule.
2. Compare new results against the previous snapshot.
3. Flag:
   - brand-new tokens
   - rapid liquidity changes
   - holder concentration spikes
   - unusual volume jumps
   - newly active wallets
4. Emit a compact diff.
5. Escalate only the tokens that cross a threshold.

## Threshold ideas

- New token appears in the watched window
- Liquidity changes by a large percentage
- Holder count changes quickly
- Price movement is sharp relative to age
- Trade activity jumps after a quiet period

## Output shape

- new tokens
- changed tokens
- removed tokens
- alerts
- next review time

## Operating rule

- Keep monitoring lightweight.
- Avoid over-alerting.
- Store snapshots so comparisons are reproducible.
