# Discord Collector — opt-in research proof of concept

Uses official Discord bot Gateway + bounded REST backfill. Not a selfbot, not
global Discord search, and emits privacy-minimized V2 events to the central Intelligence source outbox when the consumer is explicitly run.
Both Discord platform permission for the proposed use AND the affected
communities' permission must exist; configuration is merely an audit record.

## Prerequisites

- Node.js 22+, isolated PostgreSQL source database with restricted access.
- Installed authorized Discord bot, View Channel, Read Message History,
  and permitted Message Content privileged intent where necessary.
- Reviewed purpose, lawful basis, data-minimization and erasure procedures.
- Real bot tokens, raw messages, private rights files and source DB URLs must
  never be committed or exposed to central events/AI/logs.

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

Disabled by default:
~~~sh
cd discord-collector
npm install
npm test
DISCORD_COLLECTOR_ENABLED=true \
DISCORD_BOT_TOKEN=REDACTED \
DISCORD_SOURCE_DATABASE_URL=postgresql://REDACTED \
DISCORD_AUTHORIZATION_PATH=/private/guilds.json \
npm start
~~~

Optional historical sync also requires DISCORD_BACKFILL_ENABLED=true and a
strictly positive DISCORD_BACKFILL_MAX_MESSAGES. Never set an unbounded budget.

## Safeguards

- Source-local PostgreSQL, explicit guild/channel allowlist.
- SQLite and other source DBs are untouched.
- Message create/edit/delete; partial deletion uses the trusted guild in
  the authorization map, not a guessed guild.
- Source revision timestamps protect recent edits from being replaced by
  stale REST history; first observation time is preserved.
- Delete tombstones erase current and retained revision text and prevent
  resurrection after late replay.
- Old messages are rejected at ingestion based on retention_days.
- A startup and 15-minute sweep erases expired messages/revisions and rows
  for channels removed from the authorization list at restart.
- Backfill cursor only advances after a successfully persisted page.

## Still NOT production ready

- Access removal at Discord itself is not detected/reconciled automatically.
- Missing robust live gap catch-up and event retry/DLQ.
- No rights expiry revalidation or full DSAR/audit cleanup of derived content.
- No automatic live consumer activation; use the explicit Intelligence ETL opt-in and migration 022.
- No token verification/linking, complete coverage model, feature scoring or UI.
- Deletion tombstones retract prior Intelligence timeline/evidence, but retention expiry and channel revocation still require destination-side erasure before production.
- No deployment without separate approval of exact Discord Developer Policy usage.
- Service tests use fake data; a PostgreSQL integration test runs in CI only.


## Optional bounded restart gap scan

Set DISCORD_GAP_RECOVERY_ENABLED=true and optionally
DISCORD_GAP_RECOVERY_MAX_PAGES=5 (1..50), in addition to the existing live
collector flags. At startup, before Gateway login, the collector snapshots
the last message ID in each authorized channel. Once connected, it walks
authorized recent history backwards with REST until the old watermark is
found or a strict request budget is reached.

Results are persisted in discord_recovery_checks with statuses:
- initial_unverified: never seen before; no claim of prior completeness.
- bounded_recovery: the old watermark was reached in the bounded pass.
- gap_unresolved: page budget exhausted or old watermark not reached.
- failed: REST access, permissions or storage encountered errors.

A persisted unresolved baseline survives restarts and is only resolved after
a later scan reaches that same watermark. No status ever claims that missed
edits or deletes during downtime were fully reconstructed. This is NOT
complete Discord source coverage and does not authorize scraping. A separate
coverage model, durable retry queue, and full reconciliation are still required.


## V2 transactional outbox integration

The collector now installs the shared PostgreSQL outbox schema and emits three
registered Event Envelope V2 event kinds: discord_message_observed,
discord_message_edited and discord_message_deleted. The source message/revision
mutation and outbox insert run in the same PostgreSQL transaction. The envelope
emittedAt is pinned to the exact source outbox created_at timestamp.

Shared events contain only guild/channel/message Snowflakes and source clocks.
They never contain message text, author IDs/handles, attachment URLs, raw
pointers or content fingerprints. The source-local store may retain content
only under the reviewed allowlist and retention period.

To consume events, configure the Intelligence ETL with
DISCORD_SOURCE_DATABASE_URL pointing to this source database and
INTELLIGENCE_DATABASE_URL pointing to the separate destination database.
Apply destination migrations 001, 002, 004, 017, 019 and 022. Then explicitly
run INTELLIGENCE_ETL_ENABLED=true node scripts/run.mjs --source discord --once
--limit 50, or add discord to the explicitly enabled supervisor source list.
No bot token is required by the Intelligence consumer. Both the collector and
consumer remain disabled unless their separate opt-ins are set.

A Discord delete tombstone removes prior metadata-only timeline rows and
observed/edited evidence in the destination transaction while retaining the
tombstone and inbox identity for replay safety. Source-side expiry/revocation
removes pending outbox rows, but full destination-side erasure for retention
expiry, channel revocation, backups and derived features remains a production
blocker. Do not enable a live collector or commercial use without current
Discord Developer Policy, community permission and data-rights review.
