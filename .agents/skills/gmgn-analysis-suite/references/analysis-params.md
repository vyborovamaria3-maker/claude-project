# Analysis Parameters

## Discovery presets

- Default chain: `sol`
- Default interval: `5m`
- Use `--raw` when the data is going to be post-processed
- Add market-cap and liquidity filters when ranking candidates

## Token presets

- Use `1m` resolution for fast-moving tokens
- Use `5m` or `15m` for stability checks
- Add holder concentration checks for risk review

## Wallet presets

- Default review period: `30d`
- Pair holdings with activity and stats
- Check token balance only when one token matters

## Risk filters

- `--max-top-holder-rate 0.2`
- `--max-bundler-rate 0.2`
- `--max-fresh-wallet-rate 0.2`
- `--min-liquidity 10000`
- `--min-marketcap 50000`

