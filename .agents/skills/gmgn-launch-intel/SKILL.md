---
name: gmgn-launch-intel
description: Narrow GMGN skill for swap, strategy orders, launchpad cooking, and execution-sensitive workflows.
---

# GMGN Launch Intel

## Purpose

Use this skill for execution-sensitive work:

- swaps
- multi-wallet swaps
- strategy orders
- stop-loss / take-profit workflows
- launchpad cooking
- cashback / buyback launch modes

## Safety

- Always confirm chain, wallet, token, and amount before execution.
- Prefer analysis-only output if the user is still comparing options.
- Use real scripts or CLI wrappers instead of pseudo commands.

## Suggested commands

- `node scripts/gmgn-exec.mjs swap`
- `node scripts/gmgn-exec.mjs multi-swap`
- `node scripts/gmgn-exec.mjs strategy-list`
- `node scripts/gmgn-exec.mjs strategy-create`
- `node scripts/gmgn-exec.mjs strategy-cancel`
- `node scripts/gmgn-exec.mjs cooking-stats`
- `node scripts/gmgn-exec.mjs cooking-pump`
- `node scripts/gmgn-exec.mjs cooking-fourmeme`
- `node scripts/gmgn-exec.mjs cooking-clanker`
- `node scripts/gmgn-exec.mjs cooking-flap`

## Output shape

Return:

1. required inputs
2. safety checks
3. command shape
4. confirmation step

## References

Read [references/output-templates.md](references/output-templates.md) for structured output.
Read [references/analysis-params.md](references/analysis-params.md) for presets and filters.

