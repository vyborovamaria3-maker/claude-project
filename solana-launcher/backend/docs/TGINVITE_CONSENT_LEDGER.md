# TGInvite: durable, fail-closed consent and job ledger

**Status: foundations only — no Telegram invitation dispatch.**

Migration `0027_tginvite_consent_ledger` creates two owner-scoped tables:

- `telegram_invite_consents`: recorded opt-in proof kind, HMAC-SHA-256
  recipient and proof digests, verification timestamp, revocation timestamp.
  Raw Telegram user IDs and full webhook payloads are **not** stored.
  Unique proof digests prevent replayed events from minting new consent.
  A newly verified update can represent fresh opt-in after revocation;
  the earlier event remains auditable.
- `telegram_invite_jobs`: owner-bound, consent-referencing jobs with unique
  request idempotency keys. The database CHECK constraint permits only
  `blocked_transport` and `cancelled`. Neither the API nor this service
  has a Telegram send method or a route to mark jobs as sent.

## Currently exposed endpoints

The FastAPI backend requires both an active subscriber JWT and the
`X-TGInvite-Service-Key` server secret for:
- `GET /api/v1/tginvite/invite-jobs?limit=50`: returns only the requesting
  owner's job ID, destination chat ID, status and created timestamp.
- `POST /api/v1/tginvite/invite-jobs/{job_id}/cancel`: owner-only cancellation.

The Next.js authenticated `/api/tginvite/jobs` proxy allows GET and
POST `{"action":"cancel","jobId":"<uuid>"}`. It strictly whitelists
response fields and rejects attempts to submit jobs or dispatch invitations.
It never forwards Telegram IDs, consent hashes or raw backend errors.

## Trusted proof boundaries and Telegram webhook

`record_verified_opt_in` remains an **internal Python service**, not an HTTP
endpoint. Its `VerifiedTelegramOptIn` input is constructed only by the dedicated
`POST /api/v1/tginvite/consent-webhook` after a request proves the configured
Bot API secret and matches a trusted operator binding.

The **dedicated** opt-in bot must be configured by an operator using Telegram
Bot API `setWebhook` with this HTTPS endpoint, a randomly generated
`secret_token`, and `allowed_updates=["chat_join_request"]`. This bot
must have appropriate administrative rights in the destination chat to receive
join requests. **Do not reconfigure the site's existing Telegram bot webhook**:
one Telegram bot has only one webhook endpoint, so either use a separate opt-in
bot or build a verified fan-out router in a later stage.

Backend-only environment settings (all default empty; absence yields HTTP 503):

- `TG_INVITE_CONSENT_WEBHOOK_SECRET`: exactly the secret configured through
  Telegram `setWebhook`; 32–256 random URL-safe characters.
- `TG_INVITE_CONSENT_BOT_ID`: the decimal numeric identity of that bot,
  obtained from Telegram `getMe` and verified by the operator.
- `TG_INVITE_CONSENT_CHAT_BINDINGS`: JSON map of *verified* numeric negative
  Telegram chat IDs to canonical subscriber UUIDs, e.g.
  `{"-100123456789":"123e4567-e89b-42d3-a456-426614174000"}`. No owner
  ID or destination binding is ever accepted from the browser or a Telegram update.
  An operator must confirm chat authorization and bot administration before
  adding each binding; this is not self-service proof of ownership.
- `TG_INVITE_CONSENT_HMAC_KEY`: an independently generated Base64-encoded key
  of at least 32 random bytes, distinct from the session-vault and JWT keys.
  Back it up securely: losing/rotating it changes recipient and update digests.

The FastAPI endpoint compares the header
`X-Telegram-Bot-Api-Secret-Token` in constant time, parses no more than 32 KiB,
accepts only explicit `chat_join_request` updates from non-bot senders,
validates the chat binding and age (no older than 24 hours, no more than 5
minutes in the future), and stores only HMAC proof hashes. The Telegram
`from.id` represents the requesting identity *as reported by the authenticated
Bot API update*, not a user ID supplied by an app client. Delivery of the same
`update_id` cannot be recast as consent for another chat, user, or owner.
All other Telegram update types are ignored without recording consent.

**Important scope:** a join request is a request to join that destination
chat. It is **not** blanket consent to direct invitations, bulk messaging or
other campaigns. No automated invitations are enabled by this webhook.
A UI checkbox, username, imported contact or user-supplied Telegram ID
never establishes verified recipient consent.

`plan_non_dispatching_job` checks owner, destination, proof revocation,
verification age (90 days) and idempotency before creating a blocked job.
Previously revoked proofs cannot be revived by webhook retries. A newer
verified event must be recorded explicitly.

**Operational release blockers:** operator configuration and authorization of
the webhook bot/chat mapping, verified webhook delivery using a real Telegram
sandbox join request, consent withdrawal integration, full cancellation
enforcement against future workers, worker-safe receipt storage,
retention/deletion policy, consenting sandbox Telegram E2E and compliance review. The existing
`inviteFromFetched` action remains HTTP 501 even if the new tables exist.
Never bypass that gate with client-provided flags or imported contacts.
