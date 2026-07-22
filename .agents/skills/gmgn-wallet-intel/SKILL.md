---
name: gmgn-wallet-intel
description: Narrow GMGN skill for wallet, portfolio, tracking, smart-money, and KOL analysis.
---

# GMGN Wallet Intel

## Purpose

Use this skill for wallet-centric analysis:

- portfolio holdings
- portfolio stats
- portfolio activity
- token balance
- created tokens
- tracked wallets
- smart-money feeds
- KOL feeds

## Workflow

1. Identify the wallet or watchlist question
2. Pull the narrowest feed first
3. Add stats and holdings to explain behavior
4. Return performance, positions, then recent activity

## Suggested commands

- `node scripts/gmgn-wallet.mjs holdings`
- `node scripts/gmgn-wallet.mjs stats`
- `node scripts/gmgn-wallet.mjs activity`
- `node scripts/gmgn-wallet.mjs token-balance`
- `node scripts/gmgn-wallet.mjs created-tokens`
- `node scripts/gmgn-wallet.mjs follow-wallet`
- `node scripts/gmgn-wallet.mjs follow-tokens`
- `node scripts/gmgn-wallet.mjs smartmoney`
- `node scripts/gmgn-wallet.mjs kol`

## Output shape

Return:

1. performance summary
2. holdings and balances
3. recent actions
4. risks and patterns

## References

Read [references/output-templates.md](references/output-templates.md) for table and JSON layout.
Read [references/analysis-params.md](references/analysis-params.md) for wallet review presets.

