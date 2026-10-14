# Telegram Collector — resumable historical backfill

This admin-only feature complements the existing incremental Telegram Intelligence monitor.
It retrieves **older messages** from a channel that the configured MTProto account
already has permission to read. It never joins chats, sends messages or invites users.

## API

`POST /api/v1/telegram/backfill` requires a valid superuser bearer token.

Request:

```json
{"channel":"@publicchannel","post_limit":200}
```

- Only a public `@username` is accepted (not an invitation URL or a user profile).
- `post_limit` defaults to 200 and is limited to 1–1000 messages per invocation.
- Admin requests are throttled to 2 per minute. Production requires an available
  shared rate limiter; the endpoint fails with 503 if it cannot enforce quotas.
- The Telegram service must already be configured with an authorized MTProto session.

Sample response fields:

```json
{
  "mode": "backfill",
  "oldest_before": 1200,
  "oldest_after": 1001,
  "new_messages": 200,
  "backfill_may_remain": true
}
```

## Resume behavior

1. If this channel has no saved messages, the first request stores up to `post_limit`
   newest messages (initial seed).
2. Subsequent requests query the **minimum saved Telegram message ID** for that
   channel and fetch messages strictly older than it.
3. The saved database rows are the durable checkpoint: a process restart does not
   force the collector to start over, and the existing unique constraint
   `(channel_id, telegram_message_id)` protects against duplicated message rows.
4. `backfill_may_remain: true` means the batch limit was reached; it **does not**
   prove that more older messages exist. When `new_messages=0`, older accessible
   history has been exhausted at the time of the check.
5. Fresh-post monitoring remains handled by the normal `/scan` flow. The backfill
   endpoint is not a scheduler or durable job queue.

## Operational safeguards

- Process channels sequentially; overlapping backfill workers have not yet been
  made concurrency-safe. A distributed per-channel lease is a separate follow-up.
- Do not run unbounded loops against Telegram. Respect `FLOOD_WAIT`, permission
  errors, and manual authorization.
- Database retention and privacy policy apply to stored message content.
- Only administrators should have access to the saved-message export API.
- Full history is not guaranteed: deleted, inaccessible or otherwise hidden
  Telegram messages cannot be recovered.
