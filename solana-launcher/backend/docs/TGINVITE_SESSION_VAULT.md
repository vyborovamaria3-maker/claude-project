# TGInvite encrypted session vault (Draft PR #62)

Telegram user sessions are saved on the FastAPI backend, not in browser localStorage or HTTP responses. The payload (API ID, API hash and MTProto session string) is AES-256-GCM encrypted with a per-owner authenticated associated-data binding. A dedicated backend endpoint is accessible **only** when both conditions hold:

1. The request carries a valid, active subscriber's JWT.
2. The Next.js server provides the separate `X-TGInvite-Service-Key` secret.

## Configuration

Set the same value for `TG_INVITE_INTERNAL_KEY` in Next.js and FastAPI. It must have at least 32 random characters. Set `TG_INVITE_SESSION_ENCRYPTION_KEY` **only** in FastAPI: standard Base64 representing exactly 32 random bytes. Supply both through secrets management; never commit them or expose them as `NEXT_PUBLIC_*`.

To generate a new encryption key locally:

```bash
python -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"
```

Create the internal key with your password manager or secure random generator. The keys must not be reused for JWTs, subscription service access or other features. Leaving either key unset disables the vault (fail closed).

Run Alembic migrations to head before allowing Telegram logins. Migration `0025_telegram_invite_sessions` introduces the vault; migration `0026_tginvite_session_generation` adds a monotonically increasing SQL generation and nullable ciphertext for durable revocation tombstones. **Deploy the migration before the updated Next.js clients**: session PUTs now require `X-TGInvite-Expected-Generation`.

## Security and operational notes

- Existing browser-stored Telegram sessions were deliberately cleared by the previous hardening stage. Users must re-authenticate once.
- Data is encrypted in the DB; avoid logging decrypted payloads, credentials or session strings.
- Backup the encryption key separately and securely. Loss of all keys that can decrypt the vault makes session restoration impossible.
- Key rotation is supported through a controlled, all-or-nothing database migration described below. An old key remains necessary until every row has been re-encrypted.
- One encrypted MTProto session is stored per application account. Access never trusts a client-supplied owner identifier.
- Session revocation requires the `disconnect` action. Removing the DB record prevents future restoration, but does not revoke Telegram sessions elsewhere; use Telegram's session controls for that.
- The existing Next.js GramJS client remains in-process. Concurrent multi-worker requests and crash recovery still need integration testing and a distributed session lease/worker design before production.
- Invitation functionality remains disabled until the complete consent and job-ledger workflow is implemented.

## Authenticated public-message preview

The Parser tab includes **Preview 50**. It calls the protected Next.js endpoint
`POST /api/tginvite/messages` with `{"username":"@PublicChannel","limit":50}`.
The Next.js server forwards the active subscriber's JWT and the internal service key to
`POST /api/v1/tginvite/messages`. FastAPI decrypts that specific owner's session,
uses a fresh Telethon client, reads at most 200 accessible public channel/group messages,
then disconnects. No user IDs, phone numbers, access hashes, or session strings
are returned to the browser. Session state and message texts are not persisted by this preview.

Only public usernames are accepted; private invitation links, user profiles and
private chats are intentionally rejected. Rate limit: six requests per authenticated
account per 60 seconds. Missing credentials and revoked sessions fail closed.

## Operational key rotation

1. Back up the database and the current encryption key in a separate secure location.
2. **Pause TGInvite session writers / logins on every Next.js and FastAPI worker**. Do not rotate while users can connect, disconnect or create sessions.
3. Set `TG_INVITE_SESSION_ENCRYPTION_KEY` to a new independent random 32-byte Base64 key on FastAPI; temporarily set `TG_INVITE_SESSION_PREVIOUS_KEYS` to the old Base64 key (up to four comma-separated previous keys). Neither variable should be configured in the browser.
4. Deploy the updated backend with both settings. Reads can use the old key temporarily, while new writes use only the active key.
5. With writers still paused, run from `solana-launcher/backend`:

```bash
python -m app.cli.rotate_tginvite_vault
```

The command acquires database row locks where supported and re-encrypts all existing Telegram vault rows in **one transaction**. A corrupt or unreadable row causes rollback rather than partial migration. It reports a record count only; it never prints session secrets.

6. Verify the job completed, restart backend workers using **only** the new primary key with `TG_INVITE_SESSION_PREVIOUS_KEYS` unset, and verify a permitted test account can reconnect from its saved session.
7. Re-enable login and session writes. Retire the previous key from runtime secrets only after the rotation and recovery checks have passed.

**Limitations:** This is database encryption-key rotation, not revocation of Telegram's own authorization keys. Revocation and active Telegram RPCs still need a database-backed generation fence, or an equivalent fully serialized command worker, before production use with multiple Next.js processes.

## Shared login challenge leases

The Next.js `sendCode` operation now acquires an owner-scoped, ten-minute login lease via the internal FastAPI endpoint `POST /api/v1/tginvite/login-lease`. FastAPI generates a high-entropy token stored atomically in Redis with `SET NX EX`; the token remains only in the worker's in-memory challenge state, never in browser responses or localStorage. `completeLogin` verifies that token against Redis before submitting a Telegram code or 2FA password. Successful login releases the lease; cancelling/restarting a login explicitly resets it and closes the local client.

A second worker attempting `sendCode` while a lease is active receives HTTP 409 instead of creating an overlapping Telegram challenge. All operations return 503 if Redis is unavailable; **there is no process-local fallback**. Cancelling the login through the UI should release a stuck lease. Otherwise Redis automatically expires it after ten minutes. An application restart may lose its in-process challenge even if the Redis lease remains, so the user may need to cancel the attempt.

The lease avoids simultaneous active login challenges but does **not** make Next.js requests sticky to the original worker. If `completeLogin` is routed to a different instance, the user receives a controlled error and must retry through the original worker or restart. For production, use consistent worker routing or move the entire Telegram login state to a single durable/authenticated backend worker.

**SQL revocation fence:** When a login lease is acquired, FastAPI returns the owner's current vault generation along with the Redis token, solely to the internal Next.js service. The pending GramJS challenge retains both in server memory. A successful login stores its encrypted session only if the database generation still matches the original value. Every store or explicit disconnect increments the generation. Disconnect leaves a NULL-ciphertext tombstone (GET returns 404) instead of deleting the owner record, so a delayed login cannot recreate an old session after revocation. Competing writes receive HTTP 409. The CAS check and mutation share a database row lock where supported.

**Remaining limits:** A Telegram read operation that started before revocation may still complete after it; the current code does not hold a durable distributed read/write lease for the entire RPC. Login challenges remain process-local, so the app needs sticky worker routing or a unified backend challenge runner for truly seamless multi-worker login. Redis lease expiry/cancellation and durable SQL generation are complementary: the SQL generation protects against the stale-login resurrection race even when the Redis/SQL steps interleave. This PR remains draft pending live, consented sandbox E2E and broader operational validation.

