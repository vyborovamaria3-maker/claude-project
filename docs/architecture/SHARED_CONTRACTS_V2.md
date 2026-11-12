# Shared Contracts V2 — design and migration specification

Status: **DESIGN / NOT YET IMPLEMENTED**  
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
- [ ] Consumer dual-read tests pass.
- [ ] Same source event has same normalized evidence identity across V1/V2.
- [ ] Hash/collision/revision semantics pass adversarial tests.
- [ ] Solana cluster identity is retained without expanding supported chain set.
- [ ] No raw private source content or credentials in events.
- [ ] CI passes on exact commit; no skipped check counted as success.
- [ ] V2 producers remain opt-in/default-off until operator canary approval.

## 9. Current audit finding

The current contract is a useful V1 wire protocol but is not yet a full Schema Registry: `schemaVersion` is a string, source builders maintain their own payload shapes, and compatibility rules/golden fixtures are not centralized in one registry. V2 should centralize those rules while preserving V1 readers and all existing source ownership boundaries.
