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
- An installed Discord bot with only the channel-level read permissions needed
  by the Collector: View Channel and Read Message History. Administrator and
  Send Messages are explicitly rejected by preflight.
- Message Content privileged intent enabled and approved in the Discord
  Developer Portal where required; an operator must attest to this separately.
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
  "version": 2,
  "mode": "collect",
  "guilds": [{
    "guild_id": "123456789012345678",
    "channel_ids": ["223456789012345678"],
    "community_permission_reference": "internal-consent-record",
    "community_permission_expires_at": "2026-12-19T00:00:00Z",
    "policy_review_reference": "internal-platform-permission-record",
    "policy_review_expires_at": "2026-12-19T00:00:00Z",
    "reviewed_by": "operator",
    "retention_days": 30
  }]
}
~~~

### Authorization expiry and revocation

Authorization documents use schema version 2. Both the community permission
and platform-policy review have explicit expiry timestamps. The earlier
deadline controls the channel lease; leases cannot extend more than 365 days
without a new review. The Collector reloads the authorization file every
30 seconds by default (configurable from 5 to 60 seconds).

- Removing a channel from the file revokes it on the next successful reload:
  pending spool payloads are erased and source messages/revisions are purged
  only after metadata-only erasure tombstones are committed to the Outbox.
- An expired consent or policy review automatically removes that guild's
  channels from the active allowlist and triggers the same erasure flow.
- If all configured leases expire, the Collector enters erasure-only shutdown:
  it does not connect to the Discord Gateway and does not require a bot token.
- A deliberately empty allowlist is rejected in normal collect mode. To
  explicitly erase all Discord source data, use this separate operator-only
  document and enable the matching environment flag:

~~~json
{
  "version": 2,
  "mode": "erasure_only",
  "guilds": []
}
~~~

Set `DISCORD_ALLOW_ERASURE_ONLY=true` only for that deliberate operation.
The source database and spool key are still required. The Collector removes
pending spool payloads, emits erasure tombstones for every retained source
message, purges local content/revisions, releases its singleton lock and exits
without logging into Discord. The Intelligence ETL must subsequently deliver
those tombstones to retract central evidence.

Expiry timestamps are operator-maintained consent/review deadlines, not an
external proof that a community has not withdrawn permission early. If
permission is withdrawn before its recorded expiry, remove the channel from
the authorization file; the running Collector detects that change on reload.
Update the authorization file by writing a complete mode-0600 temporary
file, fsyncing it, atomically renaming it over the active file, then fsyncing the parent directory. A malformed
or unreadable policy stops collection rather than continuing under stale
permissions. These leases enforce operator-recorded consent and review
deadlines; they do not independently prove that a community has not withdrawn
consent early or that Discord bot channel permissions remain intact. Those
facts still require operator action and a separate live-permission preflight
before production rollout.

## Read-only Discord permission preflight

For every active collect-mode authorization, the Collector requires:

- `DISCORD_PERMISSION_PREFLIGHT_ENABLED=true`
- `DISCORD_MESSAGE_CONTENT_INTENT_CONFIRMED=true`

The second setting is an operator attestation that the privileged Message
Content intent is enabled and approved for this application in the Discord
Developer Portal. Discord does not expose that portal setting through the
channel-permission endpoints; the Collector cannot independently prove it.
If the intent is unavailable, message content fields may be empty or Gateway
login may be rejected.

Before opening the Gateway, the Collector performs a read-only REST preflight:

1. `GET /users/@me` identifies the bot account.
2. `GET /guilds/{guild.id}/channels` verifies guild access and enumerates
   channels visible to the bot. The response is used only to look up IDs already
   present in the private authorization file; it never expands the allowlist.
3. `GET /channels/{channel.id}/permissions/member/{user.id}` reads Discord's
   computed permissions for the bot member, including role and channel
   overwrites. The preflight requires `VIEW_CHANNEL` and
   `READ_MESSAGE_HISTORY`.

Only guild text (type 0) and announcement (type 5) channels are supported.
Missing/hidden channels, missing permissions, unsupported channel types,
invalid bot credentials, API errors and bounded rate-limit exhaustion all
fail closed. The Collector does not request or store message bodies during
preflight. It also rejects `ADMINISTRATOR` and `SEND_MESSAGES`: this service
is read-only and must not be able to administer a server or post messages.

The same check runs every five minutes by default (configurable from one to
fifteen minutes). Newly added channels are checked before they enter the live
allowlist. If a periodic check cannot verify permissions, collection stops
and the Gateway is disconnected. The preflight checks only the bot's current
effective permissions; it does not replace written community consent,
platform-policy review, or the separate Message Content intent attestation.

The preflight is bounded to 1,000 authorized channels by default. An operator
may raise `DISCORD_PERMISSION_PREFLIGHT_MAX_CHANNELS` up to 10,000 only after
reviewing API rate limits and startup/recheck duration.

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
- `DISCORD_AUTHORIZATION_RELOAD_MS=30000` (default 30 seconds; maximum 60 seconds)
- `DISCORD_PERMISSION_PREFLIGHT_ENABLED=true` (mandatory before Gateway login)
- `DISCORD_MESSAGE_CONTENT_INTENT_CONFIRMED=true` (operator attestation of portal access)
- `DISCORD_PERMISSION_PREFLIGHT_MAX_CHANNELS=1000` (default 1,000; maximum 10,000)
- `DISCORD_PERMISSION_PREFLIGHT_INTERVAL_MS=300000` (default 5 minutes; 1–15 minutes)
- `DISCORD_ALLOW_ERASURE_ONLY=true` only for an explicitly approved empty-allowlist erasure run

Use a dedicated spool directory for this source database; do not share it with another Collector. A PostgreSQL session advisory lock enforces one Collector per source database.

The encryption key is required whenever collection is enabled. The spool uses
AES-256-GCM with a unique nonce per event. The spool directory must already be mode 0700 and event files must be mode 0600; unsafe or shared paths are rejected rather than silently chmodded. Losing the key makes pending events
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
- Pending backlog is logged once per minute with event count and encrypted byte count; no message content or author IDs are logged. A full spool stops collection. The Collector drains any recoverable backlog before Gateway reconnect to reduce restart-time capacity pressure. Alerting, disk-capacity monitoring and an
  operator runbook for safely restoring capacity are required.
- Unlinking is logical erasure, not guaranteed physical sanitization on SSDs.
  Use encrypted persistent storage, restrict host access, and protect/backup
  the spool key separately. Do not back up plaintext spool contents.
- REST history can recover messages, but cannot reliably reconstruct every
  missed edit or deletion during downtime. Coverage remains explicitly
  partial/unresolved where appropriate.
- Live Discord permission preflight is mandatory before Gateway login and
  rechecked periodically. CI uses only mocked HTTP responses; operators must
  run the preflight with the real bot token and confirm the privileged intent
  in the Developer Portal before any production activation.
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
