# Shared contracts — foundation (PR-1)

Small dependency-free runtime identity and provenance contracts for the X,
Telegram and Solana collectors. This package is additive: **no collectors are
rewired**, no existing databases are migrated and no production data is touched.

## Status and scope

- Four explicitly supported chains: Solana, Ethereum, Base, Arbitrum.
- Canonical token/wallet identity: <chain>:<full address>.
- Solana: decoded 32-byte Base58 key, case-sensitive, including leading zeros.
- EVM: 0x-prefixed 20-byte hex, canonical lowercase.
- Stable social actor/source IDs use platform numeric IDs, never handles.
- Evidence references identify the actual tweet, Telegram source+message, or
  chain+transaction signature and preserve observed/occurred times separately.
- Timeline events require stable event keys, entity references and evidence.
- Wire times are explicit UTC ISO strings, not local dates.

This validates **address syntax**, not whether an address is a tradeable mint,
a verified wallet owner, or a legitimate project. It never infers an owner or
an X/TG identity link based on matching labels.

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
