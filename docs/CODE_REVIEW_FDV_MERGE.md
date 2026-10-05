# Code review — FDV merge into claude-project-main

Scope: the narrative-durability build plus the Solana execution, wallet-storage and transaction paths touched or adjacent to the FDV-derived merge.

## Fixed in this merge

### HIGH — bundle-wallet encryption key died with the browser session

**File:** `solana-launcher/lib/walletStore.ts`

The persisted Shamir shares were AES-GCM encrypted, but the AES key existed only in `sessionStorage`. After the browser session ended, the ciphertext in `localStorage` and IndexedDB could become permanently unreadable. Because the backup contains only one of three Shamir shares, this could also defeat the intended 2-of-3 recovery flow.

**Fix:** migrate the legacy session key when available and persist key material across both browser stores. New encryption failures fail closed instead of writing `UNENCRYPTED:<share>` plaintext.

Residual limitation: browser same-origin compromise can still access browser-held key material and shares. For high-value wallets, a browser-origin storage model is not equivalent to a hardware wallet or external signer.

### HIGH — transaction confirmation mixed unrelated block-height context

**File:** `solana-launcher/app/api/bundler/submit-tx/route.ts`

The confirmation strategy paired `versionedTx.message.recentBlockhash` with `lastValidBlockHeight` from a newly fetched blockhash. Those values are not guaranteed to belong to the same blockhash validity window.

**Fix:** use signature-status confirmation rather than constructing a mismatched blockhash strategy.

### MEDIUM — FDV-style route checks previously had no execution boundary in the main intelligence UI

There was no reusable deterministic layer that could reject a token because the reverse route was absent or the immediate roundtrip was structurally too expensive.

**Fix:** added `execution-risk.ts`, a server Jupiter adapter, manual investigation UI, and rate limiting. It is quote-only and cannot sign/send.

### MEDIUM — FDV pending-credit idea was coupled to a browser bot

**Fix:** extracted transaction-meta reconciliation into a pure module. It can be used by a later server execution worker without importing FDV's local wallet state.

## Open blockers / follow-up findings

### CRITICAL — Master Wallet can become an unrecoverable funded address after browser close

**File:** `solana-launcher/app/settings/MasterWalletCard.tsx`

The public key is stored in `localStorage`, but the only private key copy is stored in `sessionStorage`. After a browser/session close, the UI can reload the old public address while `getMasterKeypair()` returns `null`. The deposit flow does not require the private key, so a user can continue sending SOL to an address the app can no longer withdraw from.

**Recommendation before real funds:** migrate Master Wallet to an external signer or the audited 2-of-3 wallet store, require a verified backup before enabling deposit, and block deposits whenever signing material is unavailable.

### HIGH — wallet “encryption at rest” claim in `lib/bundler/wallet.ts` is inaccurate

The in-memory `WalletManager` uses XOR obfuscation with a seed stored beside the obfuscated bytes. This is reversible encoding, not cryptographic encryption, and should not be described as encrypted-at-rest protection.

**Recommendation:** rename it to obfuscation and avoid security claims, or replace the design with an external signer / WebCrypto-backed key boundary where appropriate.

### HIGH — `solana-wallet-warmup` uses an obsolete Jupiter host and hard-codes token decimals

**Files:**

- `solana-launcher/solana-wallet-warmup/src/config.ts`
- `solana-launcher/solana-wallet-warmup/src/actions/swap.ts`

The module still points to `https://quote-api.jup.ag/v6`. Separately, reverse swaps calculate raw token amount as `balance * 1e6` for every mint and forward output display also assumes 6 decimals. This is incorrect for arbitrary SPL tokens and can cause failed or materially wrong amounts.

**Recommendation:** do not reuse this module for production execution. Resolve mint decimals from the token account/mint, use current Jupiter API configuration, and reuse the new execution preflight before building a swap.

### MEDIUM — execution learning is not yet connected to realized fills

`execution-learning.ts` is intentionally storage-neutral. Until a server execution worker records authoritative fills, lessons should not be promoted from simulated/quoted PnL.

**Recommendation:** create an append-only server-side realized-trade table keyed by transaction signature, then feed only reconciled closed/partial fills to outcome learning.

### MEDIUM — full build cannot be proven in the supplied archive without dependencies

The archive does not contain `node_modules`; the backend Python environment also lacks `redis`. Pure TypeScript modules, analysis regressions, security regression and execution regression were run successfully, but a full `next build` / backend pytest suite requires installing the project's declared dependencies in a clean environment.

## Review verdict

The FDV ideas are useful when treated as **deterministic risk primitives**, not as a browser auto-wallet architecture. The merged preflight/reconciliation/sell-policy/learning code follows that boundary. Before enabling autonomous real-money execution, the Master Wallet persistence issue should be treated as a release blocker and the execution worker should own fills, reconciliation, policy state and outcome persistence server-side.
