# Discord Collector — opt-in research service

Uses the official Discord bot Gateway and explicitly bounded REST history
access. It is not a selfbot, does not provide global Discord search, and does
not read arbitrary servers. The collector is disabled by default.

The current integration path is:

`Discord Gateway → isolated source PostgreSQL → transactional Outbox →
Intelligence ETL → Event Envelope V2 → Inbox/evidence/timeline`.

Only privacy-minimized metadata crosses into central Intelligence. Raw message
text and author IDs remain in the isolated source database and are never put
in the shared event envelope or sent to the Intelligence AI runtime.

## Prerequisites

- Node.js 22+ and an isolated PostgreSQL source database with restricted access.
- An installed Discord bot with View Channel and Read Message History.
- Message Content privileged intent only where Discord requires it and the
  approved use permits it.
- Written community permission, platform-policy review, retention schedule,
  and a named operator responsible for revocation and erasure.
- Destination Intelligence migrations 001, 002, 004, 017, 019, 022 and 023.
- Real bot tokens, raw messages, authorization files and source DB URLs must
  never be committed or exposed to central events, AI prompts or logs.

Example authorization (private file outside the repository):

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

## Disabled-by-default setup

~~~sh
cd discord-collector
npm install
npm test

DISCORD_COLLECTOR_ENABLED=true \
DISCORD_BOT_TOKEN=REDACTED \
DISCORD_SOURCE_DATABASE_URL=postgresql://REDACTED \
DISCORD_AUTHORIZATION_PATH=/private/guilds.json \
DISCORD_MAX_IN_FLIGHT_WRITES=256 \
npm start
~~~

Optional historical sync requires DISCORD_BACKFILL_ENABLED=true and a strictly
positive DISCORD_BACKFILL_MAX_MESSAGES. Restart gap reconciliation requires
DISCORD_GAP_RECOVERY_ENABLED=true and a bounded
DISCORD_GAP_RECOVERY_MAX_PAGES value from 1 to 50. Both remain disabled by
default.

## Data and delivery safeguards

- Explicit guild/channel allowlist; unknown channels are rejected.
- Source PostgreSQL stores message content and author IDs only for the
  configured retention window. Central event payloads contain no raw text,
  author ID, guild ID or attachment URL.
- Source message revisions and their outbox events are committed atomically.
  A failed outbox insert rolls back the message/revision transaction.
- Create, edit, single-delete and bulk-delete Gateway events are supported.
- Source and destination tombstones prevent a late edit, replay or REST
  backfill from restoring a deleted/expired/revoked message.
- A deletion retracts earlier Discord evidence and timeline rows in the same
  Intelligence inbox transaction; only the metadata-only deletion audit
  remains.
- Retention expiry and channel revocation enqueue explicit erasure tombstones
  before local message/revision rows are removed.
- Source message writes and tombstone creation serialize by message identity.
- Outbox delivery is at-least-once; Intelligence Inbox idempotency protects
  against ACK loss and duplicate delivery.
- Collector tracks in-flight writes, drains them on graceful shutdown, bounds
  concurrency, and stops on persistence failure or overload rather than
  silently continuing.
- Recovery watermarks and unresolved coverage status survive restarts.
- Snowflakes are validated as unsigned 64-bit decimal IDs and remain strings;
  JavaScript Number coercion is never used.

## Current limitations — do not enable production collection yet

- Gateway dispatches are not first written to a separate disk-backed ingress
  spool. A hard process/host crash before the source PostgreSQL commit can
  still leave a source-coverage gap. The collector records known failures and
  stops on write errors, but this is not an exactly-once Gateway guarantee.
- A REST history scan can recover messages, but cannot reliably reconstruct
  every missed edit or deletion during downtime. Coverage remains explicitly
  partial/unresolved where appropriate.
- Authorization is reviewed from a private operator-supplied file; automatic
  rights-expiry revalidation and a complete empty-allowlist erasure-only mode
  are still required.
- Derived token-mention features, verified Solana mint identity, community
  quality scoring, feature-store integration, historical backtesting and
  shadow-mode evaluation are not part of this delivery foundation yet.
- No bot credentials, live Discord API calls, production database migrations,
  collector activation or deployment are included in CI or this PR.

## Restart gap statuses

At startup, before Gateway login, the collector snapshots the last message ID
for each authorized channel. If bounded recovery is enabled, it walks recent
history backwards until it reaches that watermark or exhausts its strict page
budget.

The source database records:

- `initial_unverified`: first observation; no claim of prior completeness.
- `bounded_recovery`: the prior watermark was reached.
- `gap_unresolved`: the page budget ended before the watermark.
- `failed`: REST access, permissions or storage failed.

An unresolved baseline survives restarts and is only resolved after a later
scan reaches the same watermark. This does not prove missed edits or deletes
were reconstructed and must not be interpreted as complete source coverage.
