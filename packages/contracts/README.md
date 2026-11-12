# Shared contracts — foundation and Event Envelope V2 (PR-1 / V2 phase 1)

Small dependency-free runtime identity and provenance contracts for the X,
Telegram and Solana collectors. This package is additive: **no collectors are
rewired**, no existing databases are migrated and no production data is touched.

## Status and scope

**Product target (2026-11-01): Solana only.** New token identities and blockchain evidence in the target architecture use `solana:<full-base58-address>`. Do not introduce Ethereum, Base, Arbitrum, Bitcoin or other chain producers.

**Runtime enforcement:** canonical token/wallet IDs and chain transaction evidence accept Solana only. EVM, Bitcoin and other network prefixes are rejected. Historical rows in independent source databases are not deleted or rewritten by this package.

- Target canonical token/wallet identity: `solana:<full-base58-address>`.
- Solana: decoded 32-byte Base58 key, case-sensitive, including leading zeros.
- Stable social actor/source IDs use platform numeric IDs, never handles.
- Evidence references identify the actual tweet, Telegram source+message, or
  Solana chain transaction signature and preserve observed/occurred times separately.
- Timeline events require stable event keys, entity references and evidence.
- Wire times are explicit UTC ISO strings, not local dates.

This validates **address syntax**, not whether an address is a tradeable mint,
a verified wallet owner, or a legitimate project. It never infers an owner or
an X/TG identity link based on matching labels. A Solana public key is not
promoted to a token mint without independent SPL Token / Token-2022 account proof.

## Run tests

From packages/contracts after installing Node.js 22+:

    npm install --ignore-scripts --no-package-lock
    npm run check

This builds TypeScript and runs node:test fixtures. TypeScript and pinned Node.js type definitions are the only development dependencies. No live X/Telegram/Solana credentials or database
are involved. CI runs the same command.

## Example

    import {
      formatTokenId, buildEvidenceRef, buildEntityRef, buildTimelineEvent
    } from "@claude-project/contracts";

    const mint = "So11111111111111111111111111111111111111112";
    const canonicalId = formatTokenId("solana", mint);

IDs and evidence objects are **contracts**, not a cross-database delivery
mechanism. Later PRs will explicitly adapt each legacy schema, with migration
tests and provenances. Do not alter historical applied migrations.

## Follow-up boundaries (not implemented here)

1. PR-2: additive db-common/migration checksum adapters for PostgreSQL and
   SQLite; do not replace X Collector's existing ordered migration manifest.
2. PR-4: one outbox per source database, in the SAME local transaction as the
   source write; SQLite and PostgreSQL require different claim strategies.
3. Intelligence ETL: at-least-once delivery, durable consumer deduplication,
   retry scheduling, lease expiry and replay; no fake exactly-once guarantees.
4. Twitter linker/TG normalization: gradual adoption of canonical IDs with
   backward-compatible migrations and historical backfill.
5. Blockchain: distinguish AssetMovement from Trade; a decoder fixture pass is
   not proof of complete history, full decoder coverage, or authoritative PnL.
6. AI feature store: event time, observed time, availability time, feature
   versions and evaluation horizons must avoid future-information leakage.

If legacy systems lack stable numeric source IDs, store the observed handle as
a noncanonical lookup attribute until a stable ID is obtained; do not guess.


## Native TG / X / Blockchain token identity adapter (2026-10-22)

Use `canonicalTokenIdFromNative(nativeChain, nativeMint)` for an **already identified Solana token key**. It accepts `solana` and TG's native `solana-mainnet` alias, validates the full 32-byte Base58 address and preserves case. All other network names are rejected.

```ts
canonicalTokenIdFromNative("solana-mainnet", "So11111111111111111111111111111111111111112")
// "solana:So11111111111111111111111111111111111111112"
canonicalTokenIdFromNative("solana", "So11111111111111111111111111111111111111112")
// identical shared token ID
```

This **does not verify** that the address is a token mint, attribute a message to a token, or validate a chain swap. The X and TG verified-token-link producers must independently confirm the Solana mint via SPL/Token-2022 layout and exact literal evidence; the Blockchain swap producer must pass its own transaction/balance evidence checks. Never turn an unresolved `$TICKER`, arbitrary wallet address or substring into a verified token link. Native TG DB `(chain_id,mint)` keys are unchanged by this helper.

Test: `npm --prefix packages/contracts test` includes `tests/native-token-identity.test.mjs`. The already existing `intelligence/tests/cross-source-token-timeline.test.mjs` proves **synthetic destination ingestion**, not live verified cross-source publication. The next independent gate is producer-to-consumer integration with real-source fixtures, retractions and restart/replay cases, followed by explicitly approved live checks.


## Solana-only enforcement — 2026-11-01

The canonical contracts now accept only `solana:<full-base58-address>` token/wallet IDs and `chain:tx:solana:<64-byte-base58-signature>` transaction evidence. The native adapter accepts only `solana` and TG's `solana-mainnet` alias. EVM, Bitcoin and other network prefixes fail validation.

Historical source rows are preserved. This change does not rewrite applied SQL migrations or delete legacy EVM/Bitcoin data. TG's historical graph schema may still contain `evm_address` rows for read-only compatibility; the current parser no longer emits new ones.

See [As-Is audit](../../docs/architecture/ARCHITECTURE_AS_IS_20261101.md) and [Solana-only target](../../docs/architecture/ARCHITECTURE_TARGET_20261101.md).


## Event Envelope V2 contract layer — 2026-11-12

The architecture-hardening branch now contains the first runtime V2 contract layer:

- `canonicalJsonStringify` and `sha256Canonical`: sorted object keys, preserved array order, and fail-closed handling of undefined values, sparse arrays, cycles, non-finite numbers, accessors and non-plain objects.
- `EVENT_ENVELOPE_V2_JSON_SCHEMA` plus the published JSON Schema document.
- `buildEventEnvelopeV2` / `validateEventEnvelopeV2`: deterministic event IDs, normalized clocks, strict source/evidence consistency and canonical envelope hashes.
- A source-controlled immutable registry for the current X, Telegram and Solana V1 event kinds, including payload schemas, producer/consumer ownership and compatibility mode.
- `adaptLegacyOutboxEventToV2`: a V1 normalizer that requires the immutable source outbox `created_at` value as `emittedAt`. It uses the explicit `legacy-v1` producer version marker because old rows do not record the producer build.
- Unit fixtures and a separate CI integration test that invokes the actual X, TG and Solana V1 builders.

This is a contract + consumer dual-read implementation, **not a producer migration**. Existing producers still emit V1; all outbox flags remain unchanged and default-off. `ClaimedEvent` now exposes immutable source `createdAt` from PostgreSQL and SQLite claim adapters. Generic PostgreSQL, X and TG outbox writers record `clock_timestamp()` at insert time; Solana SQLite writers retain their explicit emission timestamp. Registered V1 outbox events are validated through the V1→V2 adapter using only source `created_at`, then ingested through the existing V1 path without changing its registry-only inbox fingerprint or knownAt semantics. Unregistered legacy event kinds and read-only snapshot imports retain the prior V1 path. V2 outbox payloads are strictly validated, their outer identity and `emittedAt` are bound to the source row, and the complete envelope hash is used for inbox duplicate/collision checks.

The registry intentionally rejects unregistered event kinds and `twitter_research` in this V2 scope. It does not add EVM or other chains. Existing V1 producers sometimes encode an unknown source occurrence time as `occurredAt=observedAt`; V1 does not carry enough information to distinguish that fallback from a real timestamp, so the adapter preserves the original V1 value rather than guessing.

Producer-specific V2 builders, all-source V1/V2 parity fixtures, and the operator-approved canary remain outstanding. CI for the exact current PR head is the acceptance gate. A queued, skipped or incomplete workflow is not a pass, and this package is not a production-readiness claim.


**Cutover limitation:** V1 inbox rows retain the historical registry-only fingerprint, while V2 rows store the full envelope hash. A same-key V2 replay over an already committed V1 row therefore fails closed as `identity_collision`; it is not silently counted as a duplicate. A separately reviewed cross-version inbox reconciliation/cutover strategy is required before V2 producers are enabled or existing source outbox rows are rewritten.
