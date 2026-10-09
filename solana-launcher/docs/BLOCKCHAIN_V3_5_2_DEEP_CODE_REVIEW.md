# Blockchain Analytics V3.5.2 — Deep Adversarial Code Review

Baseline: V3.5.1 Code Review Hardening.

This pass focused on temporal correctness, evidence semantics, look-ahead leakage, wash/bundle false negatives, FIFO authority, persistence races, replay statistics, and production-scale latency.

## Fixed findings

### P0/P1 — temporal / evidence correctness

1. **Long-window coverage was fabricated for young tokens.**
   `historyComplete=true` previously forced coverage to 1 for 5m/15m/1h/6h. A two-minute-old token with exhaustive history could therefore emit a supposedly fully-covered 1h/6h signal. V3.5.2 derives coverage from the actual observed temporal span (`recentCoverageSec`). Exhaustive history proves no missing transactions inside that span; it does not manufacture time before launch.

2. **Future funding evidence could leak into lower-layer V1 analysis.**
   V2/V3 already had as-of filtering, but the base `analyzeChainQuality()` still accepted future `FundingEdge` / `FundingGroup` evidence. V3.5.2 applies the as-of boundary before V1 funding, bundle coordination, insider and sell-coordination analytics.

3. **Future funding/bundle/persisted cluster evidence could leak into V3.5 clusters.**
   Cluster construction now rejects future funding edges, future bundle starts and future persisted cluster rows. Funding edges without a usable time anchor are not promoted to temporal cluster evidence.

4. **FIFO PnL could be marked authoritative with unknowable same-slot ordering.**
   Helius timestamps are second-granularity and `RawTrade` has no transaction index. When multiple wallet trades share both timestamp and slot, deterministic sorting by signature is only a reproducible fallback, not proof of execution order. `orderingComplete=false` now prevents authoritative realized/unrealized PnL.

5. **Trade-history completeness was being confused with inventory provenance.**
   Exhausting mint transaction history does not prove that a wallet inventory was unaffected by airdrops/transfers/custody moves. V3.5.2 requires explicit `tradeLedgerProvenanceComplete=true` before promoting FIFO PnL to authoritative values.

6. **Wash patterns from launch could remain a current signal indefinitely.**
   Reciprocal wash matching, exposure, Benford/entropy and suspicious-wallet population are now scoped to the recent one-hour wash window rather than all merged launch+recent history.

7. **Wash wallet-share numerator and denominator used different time populations.**
   The numerator was recent-window suspicious wallets, while the denominator could include every launch-era trader. The ratio is now calculated against the same scoped trading universe.

8. **Mixed-quote wash price-range math could mix incomparable price units.**
   When comparable notional is USD, price-range detection now derives USD/token consistently rather than mixing SOL/token and custom-quote/token values.

9. **Missing bundle supply was converted into a false zero.**
   Empty bundle groups no longer force `currentSupplyPct=0`; an unknown current supply remains `null`.

10. **Partial zero findings could improve composite quality.**
    Zero bundle/wash/funding findings are now negative evidence only when the relevant evidence is complete. Partial evidence cannot turn "not observed" into "safe".

### P1/P2 — cluster correctness

11. **Wallet persistence used nested windows.**
    One fresh buy could appear in 5m, 15m, 1h and 6h simultaneously and produce persistence near 1. Persistence now uses disjoint time bands and token-flow direction.

12. **Temporal coactivity accepted overly coarse 15-minute coincidence.**
    Coactivity now requires same directional participation, <=60-second nearest-event distance, repeated buckets, and a minimum repeat span.

13. **Coactivity depended on input trade ordering.**
    The two-pointer nearest-event algorithm requires sorted timestamps, while upstream history may be newest-first. Buy/sell timestamp arrays are now sorted once per wallet/bucket. Newest-first and oldest-first inputs produce identical clusters.

14. **Cluster persistence used stale launch trades.**
    Coactivity is bounded by evidenced recent coverage, capped at six hours. Old launch activity no longer creates a present-day persistence score.

15. **Cluster IDs used a collision-prone 32-bit hash.**
    IDs use 64-bit FNV-1a, with exact-member migration support for the legacy ID.

16. **Persisted cluster rows could leak from the future / out-of-order writes.**
    As-of reads exclude future rows; SQL updates members/sources/persistence monotonically by `updated_at`; cluster retention is bounded.

### P1/P2 — replay / calibration

17. **Replay target lookup was O(N²).**
    Production-scale history exposed hundreds of milliseconds at 5k points. Target lookup was redesigned to a monotonic O(N) walk.

18. **Price and liquidity shared one target snapshot.**
    A timestamp with missing price could hide a nearby valid price label because liquidity happened to be present there (and vice versa). Price and liquidity targets are now selected independently, with metric-specific target timestamps and de-overlap intervals.

19. **Nominal spacing did not guarantee non-overlapping realized windows.**
    Calibration now de-overlaps using actual accepted target timestamps, including tolerance-expanded targets.

20. **Malformed/out-of-domain persisted signals could enter calibration.**
    Signal domains are validated. Duplicate `observedAt` rows are deterministically deduplicated, and malformed schema rows degrade to missing evidence rather than crashing.

21. **Replay performance regressed after stricter target semantics.**
    An intermediate run reached 20.682 ms median at 10k snapshots (20 ms gate). The implementation was optimized without relaxing semantics or the gate. Final runs are back below budget (representative latest rerun: 17.772 ms median / 18.960 ms p95).

### P2 — holder cohorts / persistence / pagination

22. **Holder cohort deltas compared materially different coverage sets.**
    Supply-share deltas require complete holder sets or >=95% sampled supply on both current and baseline snapshots.

23. **Temporal DB queries could retain oldest rows instead of newest under LIMIT.**
    Reads select newest persisted anchors first, then return them chronologically.

24. **Same-minute temporal writes were race-prone.**
    Persistence stores `payload_observed_at`; an older concurrent poll cannot replace a newer exact snapshot in the same minute.

25. **Temporal history and cluster persistence were unbounded.**
    Temporal rows have a 14-day retention window; wallet clusters have a 90-day retention window.

26. **Helius pagination could mark a max-cap partial page as exhausted incorrectly.**
    Exhaustion is now compared to the actual requested page size. Reaching the caller cap with a full requested page remains `truncated`, not `exhausted`.

## Validation

- Strict integration TypeScript: PASS
- V3.5 regression suite: 52/52 PASS
- V3.5.2 focused regression suite: 5/5 PASS
- V3.4 compatibility suite: 34/34 PASS
- V1/V2 integration suite: 29/29 PASS
- Property/fuzz invariants: 500/500 PASS
- Typical V3.5 aggregate benchmark: ~4.9 ms average, budget <20 ms
- 10,000-snapshot replay comprehensive run: 18.823 ms median / 19.400 ms p95
- 10,000-snapshot replay latest optimized rerun: 17.772 ms median / 18.960 ms p95
- `git diff --check`: PASS
- clean-baseline `git apply --check`: PASS

## Remaining architectural limitations (not hidden as fixes)

1. **Authoritative wallet PnL still needs inventory provenance upstream.** The new gate is intentionally conservative; production does not currently prove token transfers/balance deltas sufficiently to set `tradeLedgerProvenanceComplete=true` broadly.
2. **Bundle sells cannot prove which inventory lot was sold.** A wallet with pre-existing inventory can sell after a bundle entry; capped attribution reduces overstatement but cannot establish provenance without balance/transfer reconciliation.
3. **A verified common funder is not proof of common control.** CEX/ramp/service wallets can fund unrelated users. Cluster outputs remain coordination/funding evidence, not an insider verdict.
4. **Holder cohorts are wallet-age cohorts (`wallet_first_seen`), not token-acquisition cohorts.** Natural wallet aging can change cohort labels without holder transfer.
5. **Historical SOL/custom-quote -> USD fallback valuation uses the current quote USD price when per-trade USD value is absent.** Proper historical USD flow requires a timestamp-aware quote-price series upstream.
6. **Outcome calibration is still descriptive rather than full cross-token walk-forward regime calibration.** V3.6 should stratify by liquidity/lifecycle/launch regime and evaluate out-of-sample precision/recall/calibration.
7. Native `better-sqlite3` runtime execution and a full repo-wide Next.js build were not available in this isolated dependency environment; DB/provider wiring passed strict integration typecheck and static SQL review.

## Bottom line

V3.5.2 materially improves temporal correctness. The most important change is that completeness, time coverage, and as-of evidence are now treated as three different concepts. A source can be exhaustive without covering a requested 1h/6h horizon, and evidence that exists later cannot be allowed to explain an earlier snapshot.
