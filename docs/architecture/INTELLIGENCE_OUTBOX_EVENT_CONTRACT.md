# Source → Intelligence outbox event identity contract

Source row writes and outbox emission are **atomic within each source DB**.
This is a protocol for subsequent collector integration, not a claim that
live producers are already wired.

## Canonical identity

- Token: solana:<exact-32-byte-base58-mint>; EVM: chain:0x<40hex lower>.
- Wallet: chain:<wallet public address>; never identify owner from token
  account without validated mapping.
- X author: x:<stable decimal ID>, not x:@handle.
- Telegram source: tg:source:<numeric channel/group ID>.
- Evidence: x:tweet:<tweet_id>;
  tg:message:<source_id>:<message_id>;
  chain:tx:<network>:<signature_or_hash>.

## Envelope and revision keys

Payloads used by the initial Intelligence processor:

    {
      "sourceSystem": "x | tg | blockchain",
      "eventKind": "source-specific stable kind",
      "eventKey": "unique per observed revision",
      "schemaVersion": "versioned",
      "payload": {
        "registryEvent": {"sourceSystem": "...", "eventKind": "...",
          "eventKey": "...", "schemaVersion": "...",
          "entityRefs": [], "evidenceRef": {}},
        "timelineEvent": {"eventKey": "...", "schemaVersion": "timeline-v1",
          "kind": "...", "occurredAt": "...", "observedAt": "...",
          "entityRefs": [], "evidenceRef": {}, "payload": {}}
      }
    }

The envelope and registry identifiers MUST match exactly. Timestamps are UTC
ISO with explicit offsets. For Telegram, `message_id` alone is not globally
unique; always include the source/channel ID. For X metrics, use observation
time + a revision/version in eventKey. For blockchain, transaction identity
includes chain; trade decomposition may have a distinct instruction index.

## Idempotent delivery

1. Source DB transaction persists primary row + outbox event.
2. Source-specific lease claim commits BEFORE network or cross-DB work.
3. Destination inbox, registry/evidence/timeline writes commit together.
4. Only after destination COMMIT, mark source outbox processed.
5. Crash before ACK triggers replay; unique inbox event identity prevents
   duplicate graph contributions.
6. Expired leases cannot ACK; stale owner needs re-claim and replay.
7. Failed source receives bounded retry; unrecoverable failures move to DLQ.
8. Backfills and new events must be versioned: identical replays are no-ops;
   a genuinely changed observation must have a new eventKey.

## Explicitly unsupported assumptions

- A syntactically valid address proves a tradeable token or wallet owner.
- A passing fixture suite proves complete SPL token or historical coverage.
- A timestamp on an old event proves the system knew it then.
- Exactly-once network delivery across independent SQLite/PG databases.
- A ticker, username, repeated message, or correlated chart alone proves
  identity or coordinated behavior.
- Appending separate outbox events AFTER source COMMIT guarantees integrity.

Before live rollout, verify each source's actual migration manifest, DB
transaction boundaries, retention settings, and source schema against
the current repo branch; do not infer them from this document.
