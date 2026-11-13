# Shared Contracts V2 — design and migration specification

Status: **PARTIAL IMPLEMENTATION — V2 contract package and V1 adapter exist; producers and consumer dual-read remain V1**  
Date: 2026-11-12  
Parent plan: [POTAPOFF_INTELLIGENCE_V2_IMPLEMENTATION_PLAN.md](POTAPOFF_INTELLIGENCE_V2_IMPLEMENTATION_PLAN.md)  
Scope: X Collector, TG Collector, Solana blockchain module, Node Intelligence.

This document defines the next contract revision. It does not claim producers already emit V2 and does not authorize enabling source outboxes or changing production databases.

## 1. Existing V1 contract inventory

The current wire envelope is:

```ts
type OutboxEvent = {
  sourceSystem: "x" | "tg" | "blockchain" | "twitter_research";
  eventKind: string;
  eventKey: string;
  schemaVersion: string;
  payload: Record<string, unknown>;
};
```

The payload commonly contains `registryEvent` and optionally `timelineEvent`. Current producers use:
- X: `x-tweet-v1`, `tweet_observed`; event key includes tweet ID and observation time.
- Telegram: `tg-message-v1`, `message_observed` / `message_deleted`; key includes signed peer ID, message ID and revision hash.
- Solana raw wallet evidence: `chain-raw-v1`, `wallet_transaction_observed`.
- Solana swap evidence: `chain-token-evidence-v1`, `token_swap_evidence_observed`; payload hash and decoder version participate in event identity.
- Verified social token links: `token-link-v1`, with separate source revision and SPL mint proof.

Existing validation already checks source identity, event key, schema version, entity/evidence consistency, UTC timestamps, canonical IDs, payload fingerprint collisions and timeline duplicate equality. V2 must preserve these invariants, not replace them.

## 2. V2 envelope

Proposed TypeScript shape:

```ts
type EventEnvelopeV2<TPayload extends Record<string, unknown>> = {
  envelopeVersion: "event-envelope-v2";
  eventId: string;                 // stable ID derived from source + kind + eventKey
  sourceSystem: "x" | "tg" | "blockchain";
  eventKind: string;
  eventKey: string;                // unique per immutable observation/revision
  schemaVersion: string;           // version of the payload schema, not envelope
  producer: {
    name: string;
    version: string;               // release/commit/build identifier
  };
  clocks: {
    occurredAt: string | null;      // source event time; null if genuinely unknown
    observedAt: string;             // collector first observed this revision
    emittedAt: string;              // producer wrote the outbox row
  };
  entityRefs: Array<{
    kind: "token" | "wallet" | "author" | "source";
    canonicalId: string;
  }>;
  evidenceRefs: Array<{
    sourceKind: "x_tweet" | "tg_message" | "chain_tx";
    sourceId: string;
    rawPointer?: string;            // reference only; no raw private content
    contentSha256?: string;
    parserVersion?: string;
    provider?: string;
  }>;
  coverageRef?: {
    sourceSystem: "x" | "tg" | "blockchain";
    scope: string;
    windowStart: string;
    windowEnd: string;
    status: "complete" | "partial" | "unknown";
    coverageId: string;
  };
  payload: TPayload;
  payloadSha256: string;            // canonical hash of envelope content excluding itself
};
```

### Field rules

- All timestamps are UTC RFC 3339 / ISO-8601 with explicit `Z` or offset, normalized to UTC before hashing.
- `occurredAt=null` is allowed only when the source does not provide a defensible event time. Never substitute ingestion time and label it as source time.
- `observedAt` is when this exact revision was first observed; a later re-observation/revision gets a new eventKey.
- `emittedAt` is the outbox insertion time, not necessarily source time.
- `knownAt` is destination-side ingestion/commit time and MUST be assigned by Intelligence, not trusted from producer payload.
- `eventId` is deterministic from `sourceSystem + eventKind + eventKey`; it is not a random retry ID.
- `entityRefs` are references observed in this event, not identity assertions. Presence of two refs in one event does not automatically prove a person/entity link.
- `evidenceRefs` reference immutable source evidence. Raw X/TG message bodies, cookies, Telegram sessions, API keys and private credentials MUST NOT enter the envelope.
- `coverageRef` is optional for individual source events; aggregate/query outputs must independently resolve coverage for their full requested window. A per-event coverage ref cannot claim completeness of a larger universe.
- `payloadSha256` uses a documented canonical JSON serialization (UTF-8, sorted object keys, stable number representation, no undefined values). Arrays preserve order unless the field schema explicitly defines a set.
- Unknown envelope major version, unknown required field or invalid hash is rejected to quarantine/DLQ. Unknown optional extension fields are accepted only under the compatibility policy below.

## 3. Chain-specific context — Solana only for this target

Do not generalize chain fields into fake optional EVM placeholders. Solana transaction payloads may carry:

```ts
type SolanaContext = {
  chain: "solana";
  cluster: "mainnet-beta" | "devnet" | "testnet" | "localnet";
  genesisHash: string;
  signature: string;
  slot: string;                    // decimal string to avoid unsafe integer conversion
  blockhash?: string;
  parentSlot?: string;
  commitmentObserved: "processed" | "confirmed" | "finalized";
  commitmentObservedAt: string;
  provider: string;
  rawRevisionSha256: string;
  decoderVersion: string;
};
```

Rules:
- `slot` and any large numeric chain quantities are decimal strings at the wire boundary.
- A commitment observation is not an immutable guarantee that no later provider correction/reorg-like rollback can occur. Store revisions/invalidations and provider provenance.
- `finalized` is only asserted when the adapter has verified the relevant RPC commitment evidence; a parsed swap alone is not settlement or PnL.
- Canonical token IDs remain `solana:<mint>`; cluster/genesis identity is retained in event evidence so devnet/testnet observations cannot silently contaminate mainnet analytics.
- This design does not enable any non-Solana chain. A multichain expansion requires a separate ADR and migration plan.

## 4. Schema Registry and compatibility

For each `schemaVersion`, registry entry must define:
- immutable schema ID and JSON Schema;
- owning producer and consumers;
- required/optional fields;
- semantic invariants not expressible in JSON Schema;
- compatibility mode;
- deprecation date and migration owner;
- positive and negative golden fixtures.

Compatibility policy:
- Patch: documentation/metadata only; no wire meaning changes.
- Minor: additive optional fields only; old consumers must ignore unknown optional fields.
- Major: required-field, identity, timestamp, enum or semantic changes; new schema version and dual-read migration required.
- Never mutate an already published schema definition under the same version.
- Consumers must reject unsupported major versions and quarantine malformed events.
- Schema Registry is a versioned source-controlled package initially; do not add a remote registry service until deployment/scale requires it.

## 5. V1 → V2 migration

1. Add V2 envelope types, validators, canonical serializer and JSON Schema documents to `packages/contracts`.
2. Keep all V1 validators and V1 events readable. Do not rewrite historical outbox rows.
3. Add producer-specific V2 builders behind explicit opt-in flags, initially disabled.
4. Add consumer dual-read: validate V1 and V2, normalize both into one internal event model.
5. Add golden fixtures generated by each producer and validate them in the shared contract CI.
6. Run parity tests proving V1 and V2 normalize to the same evidence identity and timeline effect.
7. Use disposable PostgreSQL/SQLite fixtures to test duplicates, collisions, retries, edits/deletes and replay.
8. Only after CI and operator review, enable V2 for a tiny source canary. This is a separate operational approval, not part of code merge.
9. After measured parity and a documented rollback window, deprecate V1 for new writes. Retain V1 readers for historical replay until retention policy permits removal.

## 6. Required contract test matrix

| Case | Expected result |
|---|---|
| Valid X tweet observation with numeric author ID | Accept |
| X handle without stable author ID | Reject/unresolved; no guessed author |
| Valid Telegram message with signed peer ID | Accept |
| Telegram message without stable peer ID | Reject/unresolved |
| Telegram edit/delete revision | New immutable event key; prior evidence retained |
| Solana wallet transaction with valid signature and source hash | Accept as raw observation, not trade/PnL |
| Solana swap decoder unsupported/ambiguous | Preserve raw evidence; no verified token attribution |
| Devnet event queried as mainnet | Exclude by cluster/genesis scope |
| Unknown schema major | Quarantine/DLQ |
| Same event identity + same canonical payload hash | Idempotent no-op |
| Same event identity + different payload hash | Collision error; never ACK as duplicate |
| occurredAt missing | Preserve null; do not invent source time |
| observedAt later than emittedAt | Reject |
| Raw private text/session/API key in payload | Reject via source-specific payload policy |
| Late-arriving event in historical as-of query | Exclude until knownAt |
| Edit/delete/retraction replay | Idempotent invalidation and downstream recompute |

## 7. Files expected to change during implementation

- `packages/contracts/src/`: envelope types, schema registry, validators, canonical hash.
- `packages/contracts/test*/`: unit/golden contract fixtures (follow existing test layout).
- `packages/event-outbox/src/`: generic envelope integration only if required; preserve DB lease/ACK semantics.
- `x-collector/src/collector/persistence/intelligence-outbox.ts`: V2 X producer builder.
- `tg-collector/src/persistence/outbox.ts`: V2 Telegram producer builder.
- `solana-launcher/scripts/blockchain-intelligence-outbox.cjs` and `blockchain-token-swap-outbox.cjs`: V2 Solana builders.
- `intelligence/src/delivery.ts`: dual-read validation and normalization.
- CI workflows: shared golden fixture validation.

No existing producer or consumer should be changed until its full test layout and migration boundary have been inspected.

## 8. Exit criteria for Shared Contracts V2

- [ ] JSON Schema and TypeScript types agree (schema drift test).
- [ ] All source producers have golden V1 and V2 fixtures.
- [x] Consumer dual-read validation and focused V1/V2 delivery regression tests are implemented; exact-head CI is still pending.
- [ ] Same source event has same normalized evidence identity across V1/V2.
- [ ] Hash/collision/revision semantics pass adversarial tests.
- [ ] Solana cluster identity is retained without expanding supported chain set.
- [ ] No raw private source content or credentials in events.
- [ ] CI passes on exact commit; no skipped check counted as success.
- [ ] V2 producers remain opt-in/default-off until operator canary approval.

## 9. Current implementation and remaining gaps

The architecture-hardening branch now implements the first runtime contract layer in `packages/contracts`:

- `EventEnvelopeV2` TypeScript types, builder and fail-closed validator.
- Canonical JSON serialization and SHA-256 over the complete normalized envelope excluding `payloadSha256`.
- Deterministic `eventId` from source system + event kind + event key.
- Source-controlled schema registry with ten current V1 source/event/schema combinations: X tweet, TG message publication/deletion, Solana raw wallet observation, Solana swap evidence/revision, and X/TG verified-link and invalidation events.
- JSON Schema document checked against the TypeScript schema object in tests.
- Backward/forward/full compatibility comparison helpers and immutable schema-ID guard.
- V1-to-V2 normalizer with actual source-builder fixtures in the producer integration workflow.

The outbox contract now exposes immutable `createdAt` on every claimed row from both PostgreSQL and SQLite. Generic PostgreSQL, X and TG outbox writers stamp `created_at` with `clock_timestamp()` at insert time; Solana SQLite continues to persist its emission timestamp. X/TG remain V1 payload producers; this is only timestamp-column correctness, not a V2 producer migration. Intelligence delivery now dual-reads:
- registered V1 source events are validated through `adaptLegacyOutboxEventToV2` using only source `createdAt` for `emittedAt`, then passed to the established V1 ingestion path;
- unregistered legacy event kinds and read-only snapshot imports retain the previous V1 path;
- V2 envelopes are strictly validated, checked against the outbox identity and `createdAt`, unwrapped into the same internal payload model, and use the full envelope hash for inbox dedup/collision checks.

V1 inbox fingerprint behavior remains unchanged, preserving existing V1 replay semantics. V2 same-identity/same-hash deliveries are duplicates; same identity with a different canonical envelope hash fails as a collision. Source `occurredAt` and `observedAt` are not rewritten: downstream `knownAt` continues to derive from the original evidence observation timestamp. No production DB schema migration was added.

Existing X/TG/Solana producers still write V1. X/TG outbox SQL now sets only the existing `created_at` column with `clock_timestamp()` so the emitted clock is not transaction-start `NOW()`; payloads, flags and schema migrations remain unchanged. No V2 producer flag was added or enabled. Unknown event schemas and `twitter_research` are rejected by this initial V2 registry; multichain remains out of scope. V1 producers may already use `observedAt` as a fallback for missing source occurrence time; the adapter cannot infer whether this was a genuine source timestamp and preserves the V1 value.

**CI acceptance is pending on the exact PR head.** Queued, skipped or incomplete checks do not satisfy the exit criteria. No production migration, collector enablement, merge or deployment is authorized by this implementation.


### Consumer dual-read implementation update — 2026-11-12

The current branch includes the additive consumer/outbox step:
- `ClaimedEvent.createdAt` is populated from `outbox_events.created_at` by both claim adapters. Invalid/missing timestamps fail before the claim lease is committed.
- PostgreSQL outbox emission explicitly stamps `created_at` with `clock_timestamp()` so it represents the actual insert/emission time rather than the transaction-start `NOW()`.
- Intelligence validates registered V1 events through the V1 adapter, validates V2 envelope payloads and binds `emittedAt` to source `created_at`.
- V1 delivery retains the historical registry fingerprint and evidence clocks. V2 delivery uses the full envelope hash for duplicate/collision handling.
- Regression tests cover missing/invalid source clocks, V1 knownAt parity, V2 hash tampering, identity mismatch, duplicate replay and hash collision.

This does not switch any producer to V2, enable a source flag, or change a production schema. Complete X/TG/Solana parity and producer V2 builders remain future work. Exact-head CI is the acceptance gate.


**Cross-version replay gate:** V1 rows preserve the historical registry-only `payload_sha256`; V2 rows persist the full canonical envelope hash. If the same source identity is replayed first as V1 and later as V2, the hashes differ and Intelligence returns `identity_collision`. This is intentional fail-closed behavior, not a supported seamless V1→V2 replay. Before enabling V2 producers or rewriting source outbox payloads, add a separately reviewed cross-version reconciliation strategy (including proof that timeline/token-link/swap materializations are identical) or define a new event identity/cutover boundary. The current PR does not perform that reconciliation.


**Historical source clock gate:** existing X/TG outbox rows created before the insert-time `clock_timestamp()` change retain the old `created_at DEFAULT now()` value. Because PostgreSQL `now()` is transaction-start time, a pending historical row can have `created_at < observedAt`; the adapter will fail closed rather than move `emittedAt`. Before enabling a live consumer, the operator must inspect pending source rows for this condition and approve a separate reconciliation if needed. No source-row rewrite or production migration is part of this PR.


**Historical Solana source clock gate:** previous SQLite writers copied `observedAt` into `outbox_events.created_at`; the current writers now stamp wall-clock time at insert. Existing rows are intentionally not rewritten. Before enabling live V1→V2 delivery, inspect pending legacy Solana rows: `created_at == observedAt` may represent the old writer rather than a genuine same-millisecond emission, and this cannot be resolved from the timestamp alone. Do not infer or replace an emission clock.
