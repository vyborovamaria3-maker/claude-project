# Discord Collector — opt-in research proof of concept

Uses official Discord bot Gateway + bounded REST backfill. Not a selfbot, not
global Discord search, and **not integrated** with central Intelligence.
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
- No event outbox, V2 Discord contracts, token verification, coverage, scoring or UI.
- No deployment without separate approval of exact Discord Developer Policy usage.
- Service tests use fake data; a PostgreSQL integration test runs in CI only.
