# TGInvite / Telegram Collector v2: ten independent static review passes

Date: 2026-10-14
Reviewed starting commit: `9e19bbb22fe45bfe985e15f96d22601005150355`
PR: #62

## Method and limitations

Ten separate source-first passes were performed against the same pinned GitHub
commit, each with its own focus and a fresh inspection of the relevant files.
They were *not* ten different agents with erased memory. Findings were checked
against concrete code paths and CI outputs. No live Telegram access was used.
All fixes were committed only to the PR branch; `main` was unchanged.

| Pass | Scope inspected independently | Verdict / issue | Resolution |
|---|---|---|---|
| 1 | `lib/tginvite-auth.ts`, Next.js TGInvite API | Backend JWT identity and subscription checks are present. Origin enforcement requires deployment/proxy verification and more negative tests. | No confirmed bypass; follow-up |
| 2 | `backend/app/api/v1/tginvite_vault.py`, `lib/tginvite-vault-client.ts` | Two simultaneous session PUTs could both see no row and one hit a unique-key IntegrityError. | **Fixed**: rollback/reload/update conflict path; added regression test |
| 3 | `lib/tginvite-mtproto.ts`, login routes | Sending a replacement code orphaned the previous client; failures could retain sockets. Login challenges are worker-local and cannot survive a process restart. | **Socket cleanup fixed**; distributed login state remains |
| 4 | `app/api/tginvite/invite/route.ts`, `lib/tginvite-service.ts` | Direct user invitation is intentionally disabled pending consent verification. Legacy `previewImport` still fabricated success/failure predictions and 1,000 members per channel. Bot invite-link creation has no shared action quota. | **Forecast removed**; invite-link quota remains |
| 5 | `backend/app/services/telegram_intelligence.py`, backfill API and tests | Bounded incremental and older-history backfill use stored message IDs. Edits/reactions older than the lookback range cannot be guaranteed updated. | Limitation documented; no claim of full coverage |
| 6 | `telegram_collector/tgparser_import.py`, CLI and tests | Archive source can be matched by mutable channel title; archive identity is not cryptographically proven. Concurrent inserts can still collide on a DB uniqueness constraint. | Needs stable source validation and conflict-safe insert |
| 7 | `telegram_collector/exports.py`, history export, API | Formula protection treated trusted negative numeric values as dangerous strings, altering CSV values. No user-level source access policy yet; server export is superuser-only. | **Numeric export fixed** and regression test added |
| 8 | `AuthorizedHistoryPanel.tsx`, `TGInviteWorkspace.tsx`, browser storage | Channel change could show or export stale messages; legacy resume could display a non-existent running job. Local TGInvite storage is still browser-wide rather than account-scoped. | **Stale preview and false resume fixed**; ownership migration remains |
| 9 | DB migration 0025, vault crypto, rate limiter | DB row uniqueness is enforced. Redis limiter originally incremented and set expiry separately; failures could leave non-expiring keys. There is no automated envelope-key rotation. | **Redis quota atomicity fixed** with Lua and test; key rotation remains |
| 10 | Telegram CI and security regression tests | Starting commit passed all principal GitHub Actions workflows; gaps remain for cross-worker races, production Redis failure modes, and live authorized Telegram integration. | Added targeted race regression; latest CI must be checked |

## Changed in this review

- Recover vault unique-key insert races instead of responding with an avoidable HTTP 500.
- Prevent legacy invitation jobs from being revived as running/paused after reload.
- Reject legacy simulated import forecasts (including invented success rates).
- Clear history previews on source changes and discard stale concurrent request results.
- Keep typed negative numbers numeric in exported CSV, with text formula protection intact.
- Close superseded/failed GramJS authentication connections.
- Add targeted tests for duplicate session insertion and CSV integrity.
- Atomically increment and expire Redis rate-limit counters; test fail-closed behavior.

## Remaining release blockers

1. Production-safe session coordination and persistent per-owner login challenges across workers.
2. Stable Telegram source identity validation for archives and conflict-safe imports.
3. Per-account browser state isolation and privileged source access policies.
4. Durable opt-in evidence and invitation result ledger. Direct invitations must remain disabled.
5. Operational secret rotation, real Redis integration tests, and adversarial load testing.
6. Live integration tests with authorized accounts and owned/consenting communities.

A green CI result proves that configured tests passed, **not** that a production
Telegram integration is secure, complete, or compliant. Do not merge or deploy
this draft PR before the remaining blockers are addressed.
