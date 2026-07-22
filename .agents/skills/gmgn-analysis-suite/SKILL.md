---
name: gmgn-analysis-suite
description: Unified GMGN analysis skill for market discovery, token research, wallet analysis, signals, strategy orders, launchpad workflows, and Pump.fun monitoring across Solana and other supported chains.
---

# GMGN Analysis Suite

## Purpose

Use this skill when the task is broader than a single GMGN command family and you want a project-level analysis workflow that can cover:

- market discovery and trends
- Pump.fun monitoring
- token intelligence and security
- holder and trader analysis
- wallet and portfolio analysis
- KOL and smart-money signals
- strategy order review
- launchpad/cooking workflows
- spreadsheet-friendly and JSON output

This skill is intentionally the umbrella layer for the project.

## Safety and scope

- Treat swaps, cooking, and strategy orders as execution-sensitive.
- For any action that changes funds or launches a token, confirm chain, wallet, token, amount, and intent before proceeding.
- Prefer analysis-only output unless the user explicitly asks for execution.
- Do not invent unavailable fields; show raw values first and mark missing data clearly.

## Core coverage

### Market discovery

- Trending tokens
- Pump.fun trending tokens
- Hot-search tokens
- Newly created tokens
- Migrated tokens
- Near-completion tokens
- Signal-based discovery
- Launchpad stats

### Token research

- Core token info
- Security checks
- Kline and time-series data
- Pool and liquidity state
- Holder distribution
- Trader behavior

### Wallet and portfolio

- Holdings
- P&L stats
- Activity history
- Token balance
- Created tokens by dev wallet
- Watchlists and tracked wallets
- Smart-money / KOL watch feeds

### Signals and screening

- KOL buy signals
- Smart-money buy/sell signals
- Price surge screening
- Swing-token screening
- Risk filters for concentration and bundling

### Orders and execution

- Swap
- Multi-wallet swap
- Limit orders
- Take-profit / stop-loss / trailing strategies
- Strategy list and cancellation

### Launchpad

- Pump.fun launches
- FourMeme launches
- Clanker launches
- Flap launches
- Cashback and buyback modes

## Recommended workflow

1. Start with the narrowest question.
2. Pick the correct family:
   - market for discovery
   - token for research
   - portfolio/track for wallet behavior
   - signals for event-driven monitoring
   - orders/swap for execution-related review
   - cooking for launchpad work
3. Normalize the result into one of the supported output shapes.
4. Return risks, constraints, and next action after the raw facts.

## Command families

### Market

- `gmgn-cli market trending --chain sol --interval 5m`
- `gmgn-cli market trending --chain sol --interval 1h --platform Pump.fun`
- `gmgn-cli market hot-searches --interval 5m --raw`
- `gmgn-cli market trenches --chain sol --type new_creation`
- `gmgn-cli market trenches --chain sol --type new_creation --launchpad-platform Pump.fun`
- `gmgn-cli market trenches --chain sol --type completed`
- `gmgn-cli market trenches --chain sol --type near_completion`
- `gmgn-cli market signal --chain sol --signal-type 6`
- `gmgn-cli market signal --chain sol --signal-type 12`
- `gmgn-cli market signal --chain sol --signal-type 13`
- `gmgn-cli market signal --chain sol --signal-type 18`
- `gmgn-cli gas-price --chain eth`

### Token

- `gmgn-cli token info --chain sol --address <token_address>`
- `gmgn-cli token security --chain sol --address <token_address>`
- `gmgn-cli market kline --chain sol --address <token_address> --resolution 1m`
- `gmgn-cli token pool --chain sol --address <token_address>`
- `gmgn-cli token holders --chain sol --address <token_address>`
- `gmgn-cli token holders --chain sol --address <token_address> --tag smart_degen --order-by amount_percentage`
- `gmgn-cli token holders --chain sol --address <token_address> --tag renowned --order-by profit`
- `gmgn-cli token traders --chain sol --address <token_address>`

### Portfolio and tracking

- `gmgn-cli portfolio created-tokens --chain sol --wallet <dev_wallet_address> --order-by token_ath_mc`
- `gmgn-cli portfolio holdings --chain sol --wallet <wallet_address>`
- `gmgn-cli portfolio stats --chain sol --wallet <wallet_address> --period 30d`
- `gmgn-cli portfolio activity --chain sol --wallet <wallet_address>`
- `gmgn-cli portfolio token-balance --chain sol --wallet <wallet_address> --token <token_address>`
- `gmgn-cli track follow-wallet --chain sol`
- `gmgn-cli track follow-tokens --chain sol --wallet <wallet_address>`
- `gmgn-cli track smartmoney --chain sol`
- `gmgn-cli track smartmoney --chain sol --side sell`
- `gmgn-cli track kol --chain sol`

### Orders

- `gmgn-cli swap --chain sol --from <wallet_address> --input-token <token> --output-token <token> --amount <amount>`
- `gmgn-cli swap --chain sol --from <wallet_address> --input-token <token_address> --output-token So11111111111111111111111111111111111111112 --percent 50`
- `gmgn-cli multi-swap --chain sol --accounts <addr1>,<addr2> --input-token <token> --output-token <token>`
- `gmgn-cli order strategy list --chain sol --group-tag LimitOrder`
- `gmgn-cli order strategy list --chain sol --group-tag STMix`
- `gmgn-cli order strategy create --chain sol ...`
- `gmgn-cli order strategy cancel --chain sol --from <wallet_address> --order-id <order_id>`

### Launch

- `gmgn-cli cooking stats`
- `gmgn-cli cooking create --chain sol --dex pump --from <wallet_address> --name <token_name> --symbol <symbol>`
- `gmgn-cli cooking create --chain bsc --dex fourmeme --from <wallet_address> --name <token_name> --symbol <symbol>`
- `gmgn-cli cooking create --chain base --dex clanker --from <wallet_address> --name <token_name> --symbol <symbol>`
- `gmgn-cli cooking create --chain sol --dex pump --from <wallet_address> --name <token_name> --symbol <symbol> --buy-amt 0.1 --image-url <logo_url> --auto-slippage --is-cashback`
- `gmgn-cli cooking create --chain sol --dex pump --from <wallet_address> --name <token_name> --symbol <symbol> --buy-amt 0.1 --image-url <logo_url> --auto-slippage --is-buy-back`
- `gmgn-cli cooking create --chain bsc --dex flap --from <wallet_address> --name <token_name> --symbol <symbol> --buy-amt 2 --image-url <logo_url> --auto-slippage --flap-rate-conf '<json>'`

## Parameters to standardize

- `chain`: `sol`, `bsc`, `eth`, `base`
- `interval`: `1m`, `5m`, `1h`, `6h`, `24h`
- `resolution`: `1m`, `5m`, `15m`, `1h`, `4h`, `1d`
- `platform`: `Pump.fun`, `letsbonk`, `fourmeme`, `Clanker`, `bankr`
- `launchpad-platform`: same as `platform`
- `order-by`: `amount_percentage`, `profit`, `sell_volume_cur`, `market_cap`, `volume`, `created_at`, `token_ath_mc`
- `wallet tags`: `smart_degen`, `renowned`
- `risk filters`: `--min-marketcap`, `--max-marketcap`, `--min-liquidity`, `--max-top-holder-rate`, `--max-bundler-rate`, `--max-fresh-wallet-rate`

## Output order

### Token

1. Core token facts
2. Market context
3. Holder and trader structure
4. Security/risk signals
5. Suggested next step

### Wallet

1. Performance summary
2. Current holdings
3. Recent activity
4. Risk/behavior notes
5. Suggested next step

### Market

1. Ranked list
2. Top candidates
3. Common filters and why they matter
4. Short recommendation

### Launch / execution

1. Required inputs
2. Safety checks
3. Command shape
4. Follow-up validation

## References

Read [references/command-map.md](references/command-map.md) for a normalized map of GMGN command families.
Read [references/output-templates.md](references/output-templates.md) for table and JSON templates.
Read [references/analysis-params.md](references/analysis-params.md) for the recommended filters and presets.

