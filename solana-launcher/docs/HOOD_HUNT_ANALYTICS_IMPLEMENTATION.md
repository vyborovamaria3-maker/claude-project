# Hood Hunt-style analytics foundation (October 2026)

This adds **indicative, read-only** wallet/DEV analysis and a **local management**
watchlist. It does **not** connect to Blizz for order submission and does not
claim to reproduce proprietary Hood Hunt metrics perfectly.

## Available endpoints and UI

- GET /api/trade/hood-hunt/wallet/[address]
  - Scans up to 60 mints in the local wallet-token index and the latest
    2,000 swaps per mint.
  - Computes closed-token observed PnL, win rate, PF, hold duration, flips,
    one-buy/one-sell share and a 0.5 SOL indicative next-observed-trade copy model.
  - Treats a token with unmatched buys as open; such tokens are **not** added
    to closed-token PnL. There is no authoritative open-position mark-to-market.
  - Sniper-entry rate requires a verified token creation **slot**. The current
    API does **not** infer it from the first indexed swap and reports null.
  - Current wallet SOL balance is also reported as unknown until fetched
    from a verified RPC source.
  - Entry and exit are modeled from the next observed later slot/transaction,
    **not** same-block execution. No price-impact or external bot fill claims.
  - Missing fee/tip records are explicitly flagged.
  - UI: expand a wallet in the trade analysis view.

- GET /api/trade/dev?creator=[address] (or ?mint=[mint])
  - Includes hoodHuntPresets: Strict, Upside, Fast start, After bundle, Dev sell.
  - The new pure DEV model requires launch-time market cap, bundle-end time,
    early DEV sales and time-indexed market cap **evidence** before emitting a
    "Снайпить" status. The existing local dev token index only supplies
    ATH/creation time, so these presets will correctly say
    "Недостаточно данных" without a new intralaunch evidence collector.
  - Simulates enter-after-bundle or first-DEV-sale -> first $20k/−50% exit,
    constrained to 30 minutes, with explicit fee/tip assumptions.
  - UI: DEV Analysis panel.

- GET/POST /api/trade/hood-hunt/targets
  - Protected by production auth; manages favorite, note, watch/active/paused/
    removed state and event history.
  - POST can include reviewed=true or manually supplied latestVerdict,
    pnl7dSol, balanceSol, consecutiveLiveLosses.
  - The daily review due flag is computed at read-time; it is **not** a
    scheduled background job or notification.
  - A local "paused" status is **not** propagated to Blizz. The external
    trading executor must independently honor stop conditions.
  - UI: /trade/hood-hunt (linked from wallet and DEV panels).

## Important source-of-truth limitations

1. A wallet report of "Проверить" can be caused by missing SOL balance,
   token creation slots, or fees, even when the trading outcome is profitable.
   This is deliberate.
2. A missing data point is null, not zero. Null metrics cannot pass an eligibility
   rule. The historic SQL averages no longer coalesce null observations to zero.
3. USD volume is not calculated from a hard-coded SOL/USD conversion.
   A valid value requires observed USD quote data or timestamp-aligned SOL/USD.
4. A DEV target's ATH alone proves neither an executable snipe entry nor
   a clean path without a 50% drawdown.
5. No transfer-aware inventory reconciliation, validated live-copy execution,
   user-specific fill prices, market impact, or external Blizz stop integration
   is implemented in this change.

## Validation

Run from solana-launcher:

    npx vitest run lib/trade/hood-hunt.test.ts lib/trade/hood-hunt-strategy.test.ts
    npx tsc --noEmit

The pull request workflow runs both commands. It does not submit orders,
start collectors, write to production databases, or deploy.
