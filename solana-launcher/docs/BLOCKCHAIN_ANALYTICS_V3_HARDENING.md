# Blockchain Analytics V3 — evidence hardening

This revision hardens the V2 Solana/Pump analytics so incomplete indexer/RPC data is not silently promoted into a confident signal.

## Core evidence rules

1. `unknown` is never converted to `0`, `safe`, `organic`, or `no coordination`.
2. Every evidence family exposes availability/completeness/coverage and its source.
3. Early-launch metrics require an authoritative launch anchor. A recent-history page is never treated as token genesis.
4. Funding edges are evidence of a transfer, not proof that two wallets share an owner.
5. Timing/size similarity is a `coordinated_buy_cluster`; `verified_bundle` requires stronger evidence.
6. DEX math is only used when the actual market model is known and verified. Unsupported CLMM/DLMM/secondary-pool exit impact stays unknown.

## Review fixes

### 1. Authoritative first-block/sniper anchor

`HybridChainProvider` requests Helius address history in ascending order to establish the first successful mint-address transaction. Early trades are parsed relative to that slot. Each 1/3/5/10/20/50/100-slot window is independently marked available only when the retrieved history actually covers it.

### 2. Missing evidence no longer becomes a good score

Fresh-wallet supply, organic demand, coordination risk, insider risk, smart-money flow, migration flow, wash metrics, and similar outputs stay nullable until their minimum evidence threshold is met. Dimension scores carry explicit confidence and can be `null`.

### 3. Owner-level concentration

The primary holder path scans all token accounts for the mint with `getProgramAccounts`, aggregates raw balances by owner first, then ranks owners. `getTokenLargestAccounts` is only an explicitly incomplete fallback.

### 4. Correct adjusted concentration exclusions

System/special holdings are matched against both owner addresses and all underlying token-account addresses. Creator, bonding-curve ATA and canonical pool/vault identifiers are no longer compared against the wrong address type.

### 5–7. Current Pump protocol and custom quote support

Pump BondingCurve state is decoded directly from the on-chain account using the current discriminator/layout. The model uses `virtual_quote_reserves`, `real_quote_reserves`, `quote_mint`, current creator and completion state. Quote/token reserves are converted from raw units using declared decimals—there is no magnitude heuristic.

Trade normalization keeps non-SOL quote legs instead of discarding them. SOL-denominated metrics become unknown for non-SOL pairs unless an exact conversion source exists; USDC can carry exact USD quote value where applicable.

The canonical PumpSwap migration pool is derived from the Pump/PumpSwap PDA scheme and matched exactly before migration/exit metrics are emitted. Pump frontend API data is best-effort metadata only; security-sensitive curve state comes from RPC when available.

### 8. Expensive endpoint protection

`/api/trade/chain-full` is now included in production auth, has a per-IP rate limit, bounded TTL result cache and in-flight request coalescing. RPC/indexer HTTP calls use timeouts. Wallet-age/funding operations are bounded/cached rather than unbounded fan-out.

Environment knobs:

- `CHAIN_FULL_CACHE_TTL_MS` (default `60000`)
- `CHAIN_FULL_RATE_LIMIT_PER_MIN` (default `12`)
- `JITO_TIP_ACCOUNTS` (optional comma-separated observed tip accounts; absence means Jito evidence is unknown, not false)

### 9. Tri-state safety

Safety checks distinguish:

- checked and absent (`ok`)
- detected (`fail`/signal)
- unavailable (`unknown`)

RPC failure no longer produces a false safe result for Token-2022 extensions.

### 10. Token-2022 epoch-aware extensions

Transfer fee selection uses the current epoch and chooses the applicable older/newer fee schedule. Transfer-hook `programId` is not confused with its authority.

### 11. Conservative bundle language

Five-second/similar-size activity is only a coordinated-buy cluster. `verified_bundle` additionally requires same-slot evidence plus verified common-funder evidence or observed Jito-tip evidence. If the verifier itself is unavailable, zero verified bundles is not presented as zero bundle supply.

### 12. Trend baseline quality

5m/30m/1h/6h/24h deltas use a snapshot close to the requested target time. A stale multi-hour snapshot cannot serve as a 5-minute baseline; missing baselines remain null.

### 13. Verified exit-liquidity model

Constant-product exit simulation is emitted only for a matched canonical PumpSwap constant-product pool with decoded on-chain virtual quote reserves. Generic DexScreener liquidity is not forced through CPMM math for CLMM/DLMM/unknown markets. Legacy slippage fields inherit the verified model or stay unknown.

### 14. Canonical migration anchor

Post-migration flow is anchored only to the canonical PumpSwap pool. The recent-trade history must extend back to the pool creation time; otherwise post-migration flow is unknown rather than zero.

### 15. Field-level provenance

Top-level `sources` are built only from evidence that actually returned data. LP/events sources are not claimed when the provider returned `null`/`[]`. Quality evidence carries its own source and completeness metadata.

## Additional hardening

- Holder raw amounts use `bigint` for ranking/percentage math before UI conversion.
- 24h smart-money net flow requires a complete token lifetime or at least 24h of recent-history coverage.
- Creator lifetime cash-flow fields are not inferred from a truncated recent-history window.
- PumpSwap virtual quote reserves are decoded as signed i128 and converted only after decimal scaling.
- `getTransaction` fallback supports versioned transactions (`maxSupportedTransactionVersion: 1`).
- Funding verification uses oldest-first archival history and incoming transfer evidence; bounded fallback only labels an initial funder when history exhaustion is established.

## Intentionally unresolved / unknown without a trustworthy adapter

These are deliberately **not** guessed:

- LP lock/burn percentage when no verified lock/burn indexer is configured
- executable honeypot/sell simulation without a transaction simulator for the exact venue
- CEX attribution without a maintained address-label source
- CLMM/DLMM exit impact without a venue-specific pool/tick/bin decoder
- Jito bundle attribution when no positive tip/bundle evidence is observed

Keeping these fields unknown is part of the correctness model, not a missing default.

## Regression coverage

The deterministic regression suite covers:

- owner-level concentration + token-account exclusions
- funding evidence != ownership
- authoritative early-slot/sniper anchoring
- conservative bundle verification
- partial early-history coverage
- unknown evidence semantics
- stale trend rejection
- verified canonical exit model only
- non-SOL quote preservation
- Token-2022 safety unknown/checked-absent distinction
- 24h smart-money coverage
- migration-history coverage
- cross-token overlap + canonical migration flow
