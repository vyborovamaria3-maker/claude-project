# Shared contracts — foundation (PR-1)

Small dependency-free runtime identity and provenance contracts for the X,
Telegram and Solana collectors. This package is additive: **no collectors are
rewired**, no existing databases are migrated and no production data is touched.

## Status and scope

**Product target (2026-11-01): Solana only.** New token identities and blockchain evidence in the target architecture use `solana:<full-base58-address>`. Do not introduce Ethereum, Base, Arbitrum, Bitcoin or other chain producers.

**As-Is compatibility note:** this source snapshot still contains legacy EVM chain identifiers and EVM normalizers in `canonical-ids.ts`, with corresponding tests and downstream compatibility paths. They have not yet been removed from code. They are not part of the approved target network scope and must not be used for new product features or new cross-source token evidence. Their removal is tracked as a separate compatibility cleanup; historical rows/events must not be deleted automatically.

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

This builds TypeScript and runs node:test fixtures. Only TypeScript is needed
as a development dependency. No live X/Telegram/Solana credentials or database
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

Use `canonicalTokenIdFromNative(nativeChain, nativeMint)` for an **already identified** chain-qualified native token key. It validates the full address, maps TG's `solana-mainnet` to the shared `solana` label, preserves case-sensitive Solana base58 and normalizes EVM addresses to lowercase.

```ts
canonicalTokenIdFromNative("solana-mainnet", "So11111111111111111111111111111111111111112")
// "solana:So11111111111111111111111111111111111111112"
canonicalTokenIdFromNative("solana", "So11111111111111111111111111111111111111112")
// identical shared token ID
```

This **does not verify** that the address is a token mint, attribute a message to a token, or validate a chain swap. The X and TG verified-token-link producers must independently confirm the Solana mint via SPL/Token-2022 layout and exact literal evidence; the Blockchain swap producer must pass its own transaction/balance evidence checks. Never turn an unresolved `$TICKER`, arbitrary wallet address or substring into a verified token link. Native TG DB `(chain_id,mint)` keys are unchanged by this helper.

Test: `npm --prefix packages/contracts test` includes `tests/native-token-identity.test.mjs`. The already existing `intelligence/tests/cross-source-token-timeline.test.mjs` proves **synthetic destination ingestion**, not live verified cross-source publication. The next independent gate is producer-to-consumer integration with real-source fixtures, retractions and restart/replay cases, followed by explicitly approved live checks.


## Solana-only target decision — 2026-11-01

The target architecture supports Solana only. The EVM compatibility code visible in this revision is a legacy implementation detail, not a product promise. A follow-up cleanup must:
- stop new non-Solana token/evidence writes first;
- preserve existing legacy rows for audit/history;
- update canonical validators, evidence validators, source adapters and tests together;
- use additive migrations for existing TG graph tables; never edit already-applied migration files;
- verify all producers/consumers before removing legacy types.

See [As-Is audit](../../docs/architecture/ARCHITECTURE_AS_IS_20261101.md) and [Solana-only target](../../docs/architecture/ARCHITECTURE_TARGET_20261101.md).
