---
name: gmgn-market-workflow
description: Work with GMGN market, token, tracking, portfolio, order, and launchpad flows for Solana and other supported chains. Use when the task involves trending tokens, newly created tokens, token security, holders, traders, wallet activity, strategy orders, or launch workflows.
---

# GMGN Market Workflow

## Overview

Use this skill as the umbrella for GMGN tasks in the project. It covers market discovery, token analysis, wallet analysis, trading signals, strategy orders, and launchpad workflows.

## Install and Auth

- `gmgn-cli` is the main entry point.
- Use the configured `GMGN_API_KEY` first.
- If the key is missing, prompt the user to create one at `https://gmgn.ai/ai`.
- For launch and swap flows, also require the signing key configured by GMGN.

## Workflow Selection

1. Market discovery
   - Trending tokens
   - Hot searches
   - Newly created tokens
   - Migrated tokens
   - Near-completion tokens
   - Launchpad stats

2. Token analysis
   - Basic info
   - Security
   - Kline data
   - Liquidity pool
   - Holders
   - Traders

3. Wallet and flow analysis
   - Holdings
   - Trade history
   - P&L stats
   - Token balance
   - Watchlist tokens
   - Tracked wallet trades

4. Signal and strategy flow
   - KOL and smart money signals
   - Price surge signals
   - Buy/sell strategy orders
   - Trailing TP/SL
   - Open order review and cancellation

5. Launchpad flow
   - Pump.fun launches
   - FourMeme launches
   - Clanker launches
   - Flap tax-token launches

## Common Commands

### Market

- `gmgn-cli market trending --chain sol --interval 5m`
- `gmgn-cli market hot-searches --interval 5m --raw`
- `gmgn-cli market trenches --chain sol --type new_creation`
- `gmgn-cli market trenches --chain sol --type completed`
- `gmgn-cli market signal --chain sol --signal-type 13`

### Token

- `gmgn-cli token info --chain sol --address <token_address>`
- `gmgn-cli token security --chain sol --address <token_address>`
- `gmgn-cli market kline --chain sol --address <token_address> --resolution 1m`
- `gmgn-cli token pool --chain sol --address <token_address>`
- `gmgn-cli token holders --chain sol --address <token_address>`
- `gmgn-cli token traders --chain sol --address <token_address>`

### Portfolio and Track

- `gmgn-cli portfolio holdings --chain sol --wallet <wallet_address>`
- `gmgn-cli portfolio stats --chain sol --wallet <wallet_address> --period 30d`
- `gmgn-cli portfolio activity --chain sol --wallet <wallet_address>`
- `gmgn-cli portfolio token-balance --chain sol --wallet <wallet_address> --token <token_address>`
- `gmgn-cli track follow-wallet --chain sol`
- `gmgn-cli track follow-tokens --chain sol --wallet <wallet_address>`
- `gmgn-cli track smartmoney --chain sol`
- `gmgn-cli track kol --chain sol`

### Orders

- `gmgn-cli swap --chain sol --from <wallet_address> --input-token <token> --output-token <token> --amount <amount>`
- `gmgn-cli multi-swap --chain sol --accounts <a1>,<a2> --input-token <token> --output-token <token>`
- `gmgn-cli order strategy list --chain sol --group-tag LimitOrder`
- `gmgn-cli order strategy create --chain sol ...`
- `gmgn-cli order strategy cancel --chain sol --from <wallet_address> --order-id <order_id>`

### Launch

- `gmgn-cli cooking stats`
- `gmgn-cli cooking create --chain sol --dex pump --from <wallet_address> --name <token_name> --symbol <symbol>`

## Analysis Parameters

Use these parameters to adapt the analysis:

- chain: `sol`, `bsc`, `eth`, `base`
- interval: `1m`, `5m`, `1h`, `6h`, `24h`
- resolution: `1m`, `5m`, `15m`, `1h`, `4h`, `1d`
- market cap filters: `--min-marketcap`, `--max-marketcap`
- liquidity filters: `--min-liquidity`
- holder concentration: `--max-top-holder-rate`
- bundler / fresh wallet filters: `--max-bundler-rate`, `--max-fresh-wallet-rate`
- wallet tags: `smart_degen`, `renowned`
- order sorts: `amount_percentage`, `profit`, `sell_volume_cur`, `market_cap`, `volume`, `created_at`

## Output Rules

- For a token task, return token-level facts first, then risk analysis, then next action.
- For a wallet task, return performance, holdings, and recent behavior in that order.
- For a market task, return the list view first, then the top candidates.
- For a launch or order task, confirm the chain, wallet, and amount before execution.

## References

Read [references/command-map.md](references/command-map.md) for the command families and parameter presets.
Read [references/token-analysis.md](references/token-analysis.md) for recommended token-analysis fields and thresholds.
Read [references/wallet-analysis.md](references/wallet-analysis.md) for wallet, copy-trade, and tracker workflows.
