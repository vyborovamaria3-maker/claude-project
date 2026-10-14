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

Run Alembic migrations to head before allowing Telegram logins; migration `0025_telegram_invite_sessions` introduces the new table.

## Security and operational notes

- Existing browser-stored Telegram sessions were deliberately cleared by the previous hardening stage. Users must re-authenticate once.
- Data is encrypted in the DB; avoid logging decrypted payloads, credentials or session strings.
- Backup the encryption key separately and securely. Loss of this key prevents restoration; key rotation needs controlled re-encryption.
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
