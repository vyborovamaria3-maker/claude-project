# Discord Collector — opt-in research service

Uses the official Discord bot Gateway and explicitly bounded REST history
access. It is not a selfbot, does not provide global Discord search, and does
not read arbitrary servers. The collector is disabled by default.

The integration path is:

`Discord Gateway → encrypted local ingress spool → isolated source PostgreSQL
→ transactional Outbox → Intelligence ETL → Event Envelope V2 → Inbox/evidence/timeline`.

Only privacy-minimized metadata crosses into central Intelligence. Raw message
text and author IDs remain in the isolated source database and encrypted local
spool; they are never put in the shared event envelope or sent to the
Intelligence AI runtime.

## Prerequisites

- Node.js 22+ and an isolated PostgreSQL source database with restricted access.
- A persistent local POSIX filesystem for the spool. It must support durable
  file and directory `fsync` plus atomic same-filesystem rename. Do not use an
  ephemeral container layer or an untested network filesystem.
- An installed Discord bot with View Channel and Read Message History.
- Message Content privileged intent only where Discord requires it and the
  approved use permits it.
- Written community permission, platform-policy review, retention schedule,
  and a named operator responsible for revocation and erasure.
- Destination Intelligence migrations 001, 002, 004, 017, 019, 022 and 023.
- Real bot tokens, spool encryption keys, raw messages, authorization files
  and source DB URLs must never be committed or exposed to central events,
  AI prompts or logs.

## Private authorization

Example authorization file, stored outside the repository:

~~~json
{
  "guilds": [{
    "guild_id": "123456789012345678",
    "channel_ids": ["223456789012345678"],
    "community_permission_reference": "internal-consent-record",
    "policy_review_reference": "internal-platform-permission-record",
    "reviewed_by": "operator",
    "retention_days": 30
  }]
}
~~~

## Encrypted durable ingress setup

Generate a 32-byte key once and store it in the deployment secret manager:

~~~sh
openssl rand -base64 32
~~~

Create a dedicated directory on a persistent local volume and assign it to the
collector service account:

~~~sh
install -d -m 0700 -o potapoff -g potapoff /var/lib/potapoff/discord-ingress
~~~

Configure these secrets and settings through the service manager, not a
committed `.env` file:

- `DISCORD_INGRESS_SPOOL_DIR=/var/lib/potapoff/discord-ingress`
- `DISCORD_INGRESS_SPOOL_KEY=<canonical base64 for exactly 32 random bytes>`
- `DISCORD_INGRESS_SPOOL_MAX_BYTES=536870912` (default 512 MiB)
- `DISCORD_INGRESS_SPOOL_MAX_EVENTS=100000` (default 100,000 events)

Use a dedicated spool directory for this source database; do not share it with another Collector. A PostgreSQL session advisory lock enforces one Collector per source database.\n\nThe encryption key is required whenever collection is enabled. The spool uses
AES-256-GCM with a unique nonce per event. The directory is forced to mode
0700 and event files to mode 0600. Losing the key makes pending events
unrecoverable; changing the key while events remain queued prevents replay.
Drain the spool before key rotation. There is no implicit key fallback.

## Disabled-by-default setup

~~~sh
cd discord-collector
npm install
npm test

DISCORD_COLLECTOR_ENABLED=true \
DISCORD_BOT_TOKEN=REDACTED \
DISCORD_SOURCE_DATABASE_URL=postgresql://REDACTED \
DISCORD_AUTHORIZATION_PATH=/private/guilds.json \
DISCORD_INGRESS_SPOOL_DIR=/var/lib/potapoff/discord-ingress \
DISCORD_INGRESS_SPOOL_KEY=REDACTED \
npm start
~~~

Optional historical sync requires DISCORD_BACKFILL_ENABLED=true and a strictly
positive DISCORD_BACKFILL_MAX_MESSAGES. Restart gap reconciliation requires
DISCORD_GAP_RECOVERY_ENABLED=true and a bounded
DISCORD_GAP_RECOVERY_MAX_PAGES value from 1 to 50. Both remain disabled by
default.

## Delivery and privacy guarantees

- Explicit guild/channel allowlist; unknown channels are rejected before
  durable local storage.
- Every accepted Gateway create, edit, single-delete or bulk-delete event is
  reduced to an explicit field allowlist. Attachments, embeds, reactions,
  member profiles, display names and arbitrary Gateway payloads are not spooled.
- The Gateway callback synchronously writes an AES-256-GCM encrypted event
  record, fsyncs the file, atomically renames it to its ready name, and fsyncs
  the containing directory before returning.
- Events replay in durable sequence order after restart. A valid temporary
  record left by a crash before rename is recovered. A corrupt or partial
  temporary record fails closed; it is never silently discarded.
- The spool is bounded by bytes and event count. If it fills or a durable write
  fails, the Collector stops accepting events, records a known coverage gap
  where the database is available, and shuts down instead of dropping events
  and continuing.
- Events remain encrypted on disk while the source database is unavailable.
  They are removed from the spool only after the source transaction commits.
  A crash between PostgreSQL commit and local acknowledgement causes a replay,
  not a loss; source transaction idempotency and message tombstones make this
  safe.
- Message edits are hydrated from Discord only after the original Gateway
  dispatch is durably spooled. If an edit can no longer be fetched, the
  collector records an unresolved coverage check and continues so a following
  deletion can still be applied.
- Spool startup and periodic retention sweeps erase queued events for revoked
  channels and expired messages. Source retention/revocation emits explicit
  erasure tombstones before local database rows are removed.
- Source PostgreSQL stores message content and author IDs only for the
  configured retention window. Central event payloads contain no raw text,
  author ID, guild ID or attachment URL.
- Source message revisions and their outbox events are committed atomically.
  A failed outbox insert rolls back the message/revision transaction.
- Source and destination tombstones prevent a late edit, replay or REST
  backfill from restoring a deleted/expired/revoked message.
- A deletion retracts earlier Discord evidence and timeline rows in the same
  Intelligence inbox transaction; only the metadata-only deletion audit
  remains.
- Outbox delivery is at-least-once; Intelligence Inbox idempotency protects
  against ACK loss and duplicate delivery.
- Recovery watermarks and unresolved coverage status survive restarts.
- Snowflakes are validated as unsigned 64-bit decimal IDs and remain strings;
  JavaScript Number coercion is never used.

## Operational limits — do not enable production collection yet

- The durable guarantee begins when the Gateway callback has returned from
  the successful spool append. A hard crash during the write/fsync window may
  leave a partial temporary record; startup then fails closed for operator
  investigation. Discord Gateway does not provide an application-level
  acknowledgement that would make this exactly-once capture.
- Synchronous per-event fsync intentionally trades throughput for durability
  and can block the Node event loop. Load-test the actual persistent disk and
  Discord heartbeat behaviour at expected peak message rates before rollout.
- A full spool stops collection. The Collector drains any recoverable backlog before Gateway reconnect to reduce restart-time capacity pressure. Alerting, disk-capacity monitoring and an
  operator runbook for safely restoring capacity are required.
- Unlinking is logical erasure, not guaranteed physical sanitization on SSDs.
  Use encrypted persistent storage, restrict host access, and protect/backup
  the spool key separately. Do not back up plaintext spool contents.
- REST history can recover messages, but cannot reliably reconstruct every
  missed edit or deletion during downtime. Coverage remains explicitly
  partial/unresolved where appropriate.
- Authorization is reviewed from a private operator-supplied file; automatic
  rights-expiry revalidation and a complete empty-allowlist erasure-only mode
  are still required.
- Derived token-mention features, verified Solana mint identity, community
  quality scoring, feature-store integration, historical backtesting and
  shadow-mode evaluation are separate follow-up work.
- No bot credentials, live Discord API calls, production database migrations,
  collector activation, deployment or live Discord collection are included
  in CI or this PR.

## Restart gap statuses

At startup, before Gateway login, the collector snapshots the last message ID
for each authorized channel. If bounded recovery is enabled, it walks recent
history backwards until it reaches that watermark or exhausts its strict page
budget. The durable spool is replayed before optional history reconciliation.

The source database records:

- `initial_unverified`: first observation; no claim of prior completeness.
- `bounded_recovery`: the prior watermark was reached.
- `gap_unresolved`: the page budget ended before the watermark.
- `failed`: REST access, permissions or storage failed.

An unresolved baseline survives restarts and is only resolved after a later
scan reaches the same watermark. This does not prove missed edits or deletes
were reconstructed and must not be interpreted as complete source coverage.
