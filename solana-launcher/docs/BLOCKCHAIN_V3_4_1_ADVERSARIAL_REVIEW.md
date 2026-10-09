# Blockchain Analytics V3.4.1 — adversarial code review

## Scope

V3.4.1 is a hardening pass over V3.4 on top of the cumulative V3.3 evidence model. The review focused on evidence semantics, unit consistency, stale-history behavior, bundle/funding/wash attribution, holder-history production wiring, and CPU cost. No new RPC/HTTP calls were added to `quality-v2.ts`.

## Findings fixed

### P0/P1 — evidence correctness

1. **Mixed USD/SOL OFI units.** If only some same-quote trades had `quoteUsdValue`, the prior fallback could combine USD amounts with raw SOL amounts. Windows now use USD only when every row has USD notional; otherwise all rows are recomputed in one common quote asset.
2. **Missing custom quote amount became zero SOL.** `tradeQuoteAmount()` no longer falls back to `amountSol=0` for a known non-SOL quote. Missing custom-quote notional is `null`.
3. **Stale holder-growth anchor.** `holderGrowth1h` is anchored to analysis time, requires a fresh latest point, and rejects stale historical series.
4. **Production holder-growth was unwired.** Full owner scans now preserve exact `totalHolderCount`; the existing `chain_quality_snapshots` table gets a migration-safe nullable `holder_count`; current exact holder evidence is merged with persisted quality history before V3.4 lifecycle analysis. Partial `getTokenLargestAccounts` fallback never fabricates total holder count.
5. **Truncated holder-set Gini looked definitive.** V3.4 Gini is suppressed when upstream explicitly marks the holder set incomplete; `giniCoverageComplete` exposes that state.
6. **Funding cycles produced a numeric tree depth.** Cycles are now explicit via `cycleDetected=true`; `maxDepth=null` because hierarchical depth is undefined for a cyclic graph.

### P1/P2 — attribution correctness

7. **Bundle exit denominator included wallets with no observed entry.** Exit ratio now uses only wallets whose bundle entry is actually observed.
8. **Pre-existing wallet inventory could inflate bundle realized supply.** Later sells are attributed only up to each wallet's observed bundle-entry token amount.
9. **Wash exposure counted transfer/unknown token amounts as gross trading volume.** Net-exposure normalization now uses buy/sell rows only.
10. **Stale trades could emit a current wash volume/price mismatch.** The 15-minute wash diagnostic is anchored to analysis time, not the latest trade timestamp.
11. **Wash wallet share could include suspicious wallets absent from observed trading.** The numerator is intersected with actually observed buy/sell wallets and bounded to 0..100%.
12. **SOL whale/retail coverage was reduced by transfer rows.** `solCoverage1h` uses buy/sell market trades as its denominator.

### P2 — confidence and launch behavior

13. **Confidence penalized identical zero-valued normalized signals.** Agreement now uses average pairwise absolute distance. Identical signals `[0,0]` and `[1,1]` agree at 1; `[0,1]` agrees at 0.
14. **Complete history on a new launch still failed 1h OFI coverage.** When the upstream mint-address history is explicitly complete/exhausted, the existing token lifetime is treated as fully observed for OFI. Longer-baseline features such as 1h buyer Z-score / 2h volume growth still require their real historical windows.
15. **Legacy negative SOL notional without `quoteMint` became unknown.** SOL fallback inference now uses `abs(amountSol) > 0`; bundle similarity also normalizes signed quote amounts.
16. **Creator sell percentage was overclaimed.** Complete history can prove “no sell” or “some sell,” but trade history alone cannot infer creator allocation sold percent when inventory came from mint/transfer. Positive sell activity therefore leaves `soldPct=null` instead of fabricating 100%.

## Holder-history persistence

`chain_quality_snapshots` now includes nullable `holder_count` with a migration-safe `ALTER TABLE` check. The value is persisted only when the owner count is exact:

- full `getProgramAccounts` owner aggregation: exact `owners.size`;
- explicitly complete holder set: exact row count;
- partial `getTokenLargestAccounts` fallback: `null`.

`analyzeChainFull()` merges persisted holder-count history from the already-loaded quality supplement with the current exact owner count. This avoids another network call and avoids treating the top-20/top-50 sample length as total holders.

## Validation

- V3.4 regression suite: **32/32 PASS**.
- Performance suite: **5/5 PASS**.
- Synthetic fixture: 50 holders / 1600 trades / 20 wallets x 120 historical tokens.
- Final measured average: **~2.5 ms** per V3.4 CPU pass on this runtime; budget is `<20 ms`.
- Targeted strict integration TypeScript check across `types -> classify -> helius -> db -> full -> provider -> quality -> quality-v2 -> analyze`: **PASS**.
- `quality-v2.ts` network audit: no `fetch`, RPC or Helius references.
- `quality-v2.ts` / `types.ts`: no `as unknown as` or explicit `any` patterns.

The full repository dependency install was not used as proof of correctness because `npm ci` did not finish within the execution window. The integration typecheck instead used narrow declarations for external packages while preserving real internal blockchain module types, so cross-layer TypeScript incompatibilities remain visible.

## Remaining work for the next pass

1. Persist exact per-wallet realized/unrealized PnL and hold-lot summaries so V3.4 smart-money scoring has broader non-null historical coverage.
2. Add calibrated thresholds by token age/liquidity regime instead of one global lifecycle threshold set.
3. Add replay/backtest fixtures from captured chain snapshots (not only synthetic mocks) and evaluate false-positive rates for wash/coordination signals.
4. Add explicit atomic bundle-ID evidence source if available; Jito tips/common funder must remain “coordination,” not “verified bundle.”
5. Add per-source latency/cost telemetry to quantify provider coverage vs response-time tradeoffs without changing analytic semantics.
