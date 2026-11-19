# Discord Collector — isolated, default-off research POC

Uses the official discord.js bot API for allowed live channels and limited historical
backfill. It is NOT a self-bot, not a global Discord scraper, and not connected to
central Intelligence. User-account token scraping is not supported.

## Permissions and safety gates

- Discord platform permission for this exact use, plus documented authorization from the
  community, and an applicable privacy, retention, deletion, and access-control policy.
- Bot must have View Channel and Read Message History where required; Message Content
  privileged intent must be available and approved/authorized as applicable.
- Separate PostgreSQL source DB with restricted access; no shared production DB.
- Do not commit bot tokens, database URLs, raw Discord data, or authorization documents.
- The configuration records an operator review; it does NOT itself grant any platform rights.
- No external AI training or central event delivery is performed.
- Disabled unless DISCORD_COLLECTOR_ENABLED=true. History also requires
  DISCORD_BACKFILL_ENABLED=true and positive DISCORD_BACKFILL_MAX_MESSAGES.

Example private authorization file (outside repository):
~~~json
{
  "guilds": [{
    "guild_id": "123456789012345678",
    "channel_ids": ["223456789012345678"],
    "community_permission_reference": "internal-permission-record",
    "policy_review_reference": "internal-platform-review-record",
    "reviewed_by": "operator",
    "retention_days": 30
  }]
}
~~~

Local-only, after rights review:
~~~sh
cd discord-collector
npm install
npm test
DISCORD_COLLECTOR_ENABLED=true \
DISCORD_BOT_TOKEN=REDACTED \
DISCORD_SOURCE_DATABASE_URL=postgresql://REDACTED \
DISCORD_AUTHORIZATION_PATH=/private/authorized-guilds.json \
npm start
~~~

The source database stores messages, content hashes, revision observations,
deletion tombstones, and per-channel history cursors. Deletes clear stored current
content and revision contents; a late replay cannot resurrect the current body.
History sync is bounded per channel and replays are idempotent.

## Not production-ready

This initial vertical slice has no central outbox, V2 event schemas, reliable retry/DLQ,
reconciliation coverage, expiry/retention purge, DSAR erasure controls, permission
revocation reconciliation, integration database tests or complete monitoring.
The source-specific revision history is not a historical license to retain
previously deleted messages. Do not deploy for general collection until these
gates have been independently implemented and reviewed.
