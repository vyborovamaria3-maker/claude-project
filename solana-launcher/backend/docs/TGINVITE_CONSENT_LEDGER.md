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

## Trusted proof boundaries

`record_verified_opt_in` is an **internal Python service**, not an HTTP
endpoint. Its typed `VerifiedTelegramOptIn` input must be constructed only
after all of these conditions are checked by a **future** Telegram webhook
verifier: the Telegram bot secret/update authenticity, the actual
`from.id` identity, the owner's authorized destination-chat binding, and
that the update records a genuine recipient-initiated opt-in. A UI checkbox,
username, imported contact, or user-supplied Telegram ID does **not** establish
consent. No untrusted browser can create a verified proof.

The HMAC secret passed into the internal service must be separately generated
and managed (at least 32 random bytes), independent of encryption and JWT keys.
Do not use the illustrative test constant in production. No production proof
issuer or webhook wiring is enabled yet.

`plan_non_dispatching_job` checks owner, destination, proof revocation,
verification age (90 days) and idempotency before creating a blocked job.
Previously revoked proofs cannot be revived by webhook retries. A newer
verified event must be recorded explicitly.

**Operational release blockers:** authenticated opt-in webhook ingestion,
proof-to-owner destination binding, full cancellation enforcement against
future workers, worker-safe receipt storage, retention/deletion policy,
real consenting sandbox Telegram E2E and compliance review. The existing
`inviteFromFetched` action remains HTTP 501 even if the new tables exist.
Never bypass that gate with client-provided flags or imported contacts.
