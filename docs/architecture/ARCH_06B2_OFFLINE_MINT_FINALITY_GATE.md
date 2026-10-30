# ARCH-06b2a — offline check for Solana finalized-status and SPL Mint account receipts

**Status:** Offline validator integrated into `main` through PR #133 (original PR #149). This is **not** an operational mint-verification rollout: it validates supplied receipts and synthetic tests only; it does not fetch RPC or prove historical mint state at the transaction slot.

## Threat model and evidence boundary

ARCH-06a/b1 produces a mint attributed to a provider-parsed wallet swap, **not** independent SPL Mint account ownership, confirmation/finality, cryptographic proof or trade PnL. This step introduces:

- `buildVerificationPlan(revisionEvent)`: exact `getSignatureStatuses([[signature], {searchTransactionHistory:true}])` and `getAccountInfo(mint, {commitment:"finalized",encoding:"base64",minContextSlot:transactionSlot})` request contracts. It accepts **only supported, revision-consistent ARCH-06b1 events**.
- `verifyOfflineSwapProof(revisionEvent, receipts)`: read-only validation of supplied request+response receipts. It binds signature, mint, raw SHA256/revision and slot to the source event; checks `err === null`, RPC-reported `confirmationStatus === finalized`, exact transaction slot, and independent mint account owner/data at a read context `>= transactionSlot`.
- Recognizes classic SPL Token Program `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` and Token-2022 `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`. Parses initialized 82-byte Mint base layout; for Token-2022 extensions requires padding to offset 165, mint discriminator 1, bounded TLV entries. Rejects executable accounts, wrong program owner, Token Accounts, malformed lengths, invalid base64, invalid mint state and incomplete/ambiguous status.
- Success means **`rpc_reported_finalized_tx_and_current_mint`**, never `trade_executed`, `mint_verified_at_tx_slot` or `verified_pnl`. The existing Blockchain active evidence projection/Timeline remain unchanged.

## What a positive offline result does NOT prove

1. RPC responses are **claims by the queried endpoint**. The caller must authenticate endpoint/cluster (e.g. correct genesis hash), preserve request/response pairing and server provenance, guard against stale/replayed receipts, and compare across independent RPC providers where required. This validator cannot attest to those properties.
2. `getAccountInfo` at finalized commitment returns mint account state at the **later probe context slot**. It is **not a historical proof that this account existed, was a Mint, or had the same Token-2022 extensions at the transaction slot**.
3. `getSignatureStatuses` is not a cryptographic inclusion proof. Missing status may mean old status cache; a reorg or RPC disagreement needs separate policy. No conclusions about completeness, fills, trade identity, prices, balance recovery or PnL.
4. Token-2022 TLV structure is bounded/checked for nontruncation but **extension semantics are not decoded**. Unsupported behavior remains unknown; no trade semantics are inferred from Token-2022 metadata.
5. The module does **not** call Solana RPC, create credentials, run migrations, publish Outbox entries, update PostgreSQL, or switch on any feature flag. No live backfill. An eventually enabled production verifier must add bounded, explicitly approved RPC acquisition, trusted endpoint+cluster provenance, replay protections, independent observations and revision-aware delivery to Intelligence **before** any UI verified badge.

## How to test (offline, no paid credits)

From `solana-launcher`:

```bash
node scripts/blockchain-swap-proof-validation-test.cjs
npm run blockchain:test
```

Tests use synthetic provider-compatible event, fake finalized status and base64 mint layouts, including adversarial tests for failed/not-finalized/slot mismatches, account substitution, missing/invalid mint data and Token-2022 discriminator/TLV. No actual finalized transaction or SPL Mint was queried.

## Canonical Solana references

- [getSignatureStatuses](https://solana.com/docs/rpc/http/getsignaturestatuses)
- [getAccountInfo](https://solana.com/docs/rpc/http/getaccountinfo)
- [Token-2022 official program/layout](https://www.solana-program.com/docs/token-2022)

## Next

ARCH-06b2b: explicit user-approved, budget-limited independent RPC source with persistent signed/configured cluster provenance; snapshot/correction expiry policy; transactional, revision-fenced finality/mint attestations; PG contract, confidence states, reorg/unknown correction and UI that distinguishes historical/current/corroborated evidence. This code alone must not change the user-facing trade/PnL claims.
