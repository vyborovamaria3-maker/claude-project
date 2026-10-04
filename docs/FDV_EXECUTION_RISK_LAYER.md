# FDV-derived execution risk layer

This merge ports the useful execution/risk-management ideas from `fdv.lol` into the existing POTAPoff / `claude-project-main` architecture without importing its browser wallet, telemetry, remote-JS loader, referral/platform-fee code, or localStorage private-key model.

## Added modules

### `solana-launcher/lib/trade/execution-risk.ts`

Deterministic quote-only entry preflight:

1. quote SOL -> token,
2. reject missing route / excessive buy price impact,
3. quote a partial token -> SOL exit route,
4. reject missing or high-impact exit route,
5. quote the full expected output back to SOL,
6. compute gross immediate roundtrip loss,
7. reject entries whose roundtrip loss exceeds the configured threshold.

This is intentionally a **guard**, not a PnL oracle. It does not include final network fee, ATA rent, priority fee, transaction simulation, or block-to-block price movement.

### `solana-launcher/app/api/trade/execution-risk/route.ts`

Server-side Jupiter adapter for the preflight. The endpoint never receives a secret key and never builds, signs, or sends a transaction.

Default check:

```text
GET /api/trade/execution-risk?mint=<MINT>&inputSol=0.1
```

Relevant environment variables:

```text
JUPITER_API_KEY=
JUPITER_SWAP_API_URL=https://api.jup.ag/swap/v1
JUPITER_QUOTE_MIN_INTERVAL_MS=120
```

Without an API key, the route falls back to Jupiter's keyless endpoint and deliberately spaces quote calls. The route is also included in the existing heavy-route rate limiter.

### `solana-launcher/lib/trade/position-reconciliation.ts`

Pure helpers for resolving a token credit from transaction `preTokenBalances`/`postTokenBalances` and comparing it with an expected output. This is the safe core of FDV's pending-credit idea and is suitable for a future execution worker.

The module does not poll RPC or hold a private key. Network orchestration should live in the server-side execution worker.

### `solana-launcher/lib/trade/sell-policy-engine.ts`

Deterministic sell-intent engine with:

- independent rug-force exit,
- quote-uncertainty reconciliation guard,
- pending-credit guard,
- early/minimum-hold hard-stop logic,
- profit-lock arm/harvest/stop,
- multi-sample PnL fade detection,
- momentum cooling de-risking.

`profitLock` is explicitly stateful: when a decision returns `statePatch`, the execution/position store must persist it before evaluating the next tick.

The engine returns an **intent** (`hold`, `sell_partial`, `sell_all`). It does not submit swaps.

### `solana-launcher/lib/trade/execution-learning.ts`

Storage-neutral outcome-learning helpers:

- rolling win-rate / average PnL summary,
- missing-agent-critique queue,
- lesson canonicalization,
- promotion of repeated lessons into stable rules.

Unlike FDV's original browser-local store, no trading outcomes or rules are written to `localStorage`. Persistence should be wired to the server database when the execution worker becomes the source of truth for realized fills.

## UI

`AdvancedInvestigationPanel` now contains **Execution preflight · Jupiter roundtrip**. It is manual rather than automatic so opening an investigation does not burn Jupiter quota. It shows:

- PASS / BLOCK,
- buy price impact,
- exit-check price impact,
- immediate roundtrip loss,
- buy / exit route hop counts,
- deterministic block reason and caveats.

## Tests

`npm run execution:test` covers:

- healthy roundtrip,
- excessive price impact,
- missing exit route,
- transaction credit reconciliation,
- rug exit,
- quote uncertainty guard,
- hard stop,
- stateful profit lock,
- PnL fade exit,
- repeated-lesson promotion.

`npm run build` now runs the existing analysis regressions and this execution regression before the Next.js build.

## Explicitly not ported

The following FDV behaviors were intentionally excluded:

- private keys in `localStorage`,
- old-wallet secret archives,
- remote runtime JavaScript imports,
- telemetry/leaderboard wallet registration,
- platform/referral fees,
- browser-owned auto-wallet execution,
- dynamic code bootstrap from a remote site.

Those behaviors create avoidable supply-chain or key-management risk and are unnecessary for the intelligence/risk layer.
