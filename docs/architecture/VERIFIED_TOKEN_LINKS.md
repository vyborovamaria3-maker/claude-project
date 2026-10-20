# ARCH-05a — verified mint evidence from X / Telegram

Status: implemented as a **historical evidence contract**, not an active token-link resolver or automatically populated cross-source token timeline. Changes are in draft PR #135, stacked on ARCH-04 PR #134 and ARCH-01/03 PR #133. No live database or source collector was accessed.

## Verified against native source code

- X `tweet_token_links` / `tweet-token-linker.ts`: `mint_literal + exact` proves that an address was present in text and was in a **local known-token registry**; the registry is not guaranteed to have independently validated the SPL Mint account. X source therefore does **not** automatically emit `token_link_verified`.
- TG `resolve-token-candidates.ts`: before declaring an address a mint, existing Alchemy RPC `getAccountInfo` checks the account owner is SPL Token / Token-2022 and verifies initialized Mint bytes. The source already records `tg_token_candidates.resolution_status='confirmed_token'` and `tg_token_mentions`.
- The Telegram native chain label is `solana-mainnet`; Intelligence canonical token ID is `solana:<full-base58-address>`. Map only after verified native account evidence.
- X author identity is stable `x:<numeric_id>`; Telegram source identity is `tg:source:<numeric_peer_id>`. Never use mutable usernames, local TG source surrogate IDs or a ticker as a cross-source entity key.

## New contract

`packages/contracts/src/token-link.ts` defines `token_link_verified` / `token-link-v1` with:

- Native X tweet or TG message evidence source ID.
- Full canonical verified Solana mint ID, known SPL Mint/Token-2022 owner program, verifier provider, on-chain-check timestamp and explicit literal-address basis.
- Source-side SHA-256 revision fingerprint, bounded deterministic event identity and distinct observation / event clocks.
- Source and token entity references; no private tweet/message text or session/proxy/RPC credentials.
- **No timelineEvent** yet: a historical verified link may cease to be active when source text is edited or the message is deleted.

The destination validates the envelope and consistency **before opening a transaction**. This enforces required fields but does not replay the actual provider request; cryptographic verification or RPC integrity must be performed at the source with retained independent provenance.

## Opt-in gates

Telegram requires BOTH:
- `TG_INTELLIGENCE_OUTBOX_ENABLED=true`
- `TG_INTELLIGENCE_TOKEN_LINKS_ENABLED=true`

The link is emitted from the existing TG RPC mint resolver **inside the same native PostgreSQL transaction** as candidate/mention confirmation. The source refuses missing stable peer ID, absent literal address, wrong chain/program and deleted messages. No additional on-chain request is performed by the new emitter. Existing producers, source outbox migrations and collector startup remain unchanged.

X additionally has a tested builder / transactional source adapter requiring:
- `X_INTELLIGENCE_OUTBOX_ENABLED=true`
- `X_INTELLIGENCE_TOKEN_LINKS_ENABLED=true`
- An **explicit** on-chain SPL Mint account proof from an independently reviewed verifier supplied to the builder.

**Nothing automatically calls the X adapter yet.** The X tweet-linker only supplies candidate/precise-text-match evidence; blindly attaching `token` to every `exact` row would manufacture on-chain assurance. Supplying a `true` boolean as proof is not sufficient. An approved real proof producer and atomic caller remain work for ARCH-05b.

## What this PR deliberately does NOT claim

- No retraction-aware current link table. Entity Registry evidence is append-only *historical evidence*, not a current relationship.
- No current/historical token `queryTokenTimeline` from these events. Timeline materialization requires version-aware replacement, edit/delete retractions, and known-at semantics, planned for ARCH-07.
- No live X/TG collector rollout, saved real RPC evidence replay or existing history backfill.
- No automatic promotion from ticker, task-context mint, Base58 address shape, verified author, social username, wallet or unreviewed archive token to verified on-chain mint.
- No secret handling changes, no new SQL migrations, no host-level background process, no connection to real source databases.
- On-chain verification gives mint account existence at check time; it is not economic safety, sufficient liquidity, rug-risk assessment or an identity/ownership claim.

## Tests and review gates

- Shared contract tests reject wrong chain, invalid Mint account owner, ticker-only substitution, mismatched revision, source kind, and future verification.
- TG tests require dual flags, exact literal source text, no private export and caller-owned transaction.
- X tests require actual independent account proof input; the adapter is not on a live runtime path.
- Destination tests reject tampering before writing; historical event has no phantom token Timeline row.
- Merge only after latest-head `Shared contracts`, `TG Collector checks + security`, `X Collector quality`, `X Collector unused-code audit`, `Intelligence foundation`, `Intelligence CI`, and repository hygiene all succeed. Live operator review and restored test databases remain separate gates.

Next: ARCH-05b inject verified X mint proof from an authorized source and reconcile TG/X edits/deletes with source revisions, then ARCH-07 destination active-link materialization with retractable temporal querying.
