# Admin workspace relocation — 2026-10-29

## Scope

Move the operational UI entry points of X Collector, TG Collector and TG Invite out of the product Settings and into the Next.js administration section. The existing X/TG components and TG Invite workspace are reused without copying data, credentials or collectors. No production flags, databases, session state or collection jobs are changed.

## Route mapping

| Before | After | Behavior |
| --- | --- | --- |
| Settings → X Collector | /admin/x-collector | Original XCollectorTab rendered unchanged |
| Settings → TG Collector | /admin/tg-collector | Already-rendered TGCollectorTab retained |
| /settings/tginvite | /admin/tg-invite | Redirect to original TGInviteWorkspace |
| /tginvite, /launch/tginvite, /trade/tginvite | /admin/tg-invite | Compatibility redirects |
| /tg-collector (local development only) | /admin/tg-collector | Development redirect; production remains unavailable at old path |
| /admin/twitter-registry | /admin/twitter-registry | Registry preserved as a distinct admin module |

## Acceptance

- Settings displays no X/TG collector cards.
- `/admin` lists the three operational modules and existing X Registry.
- Each module reuses its original UI and calls the same API routes; no migration of session or database ownership.
- Existing TG Invite bookmarks redirect to `/admin/tg-invite`.
- The root `analysis:test` suite includes `scripts/admin-navigation-regression.mjs`; update and run the two local browser smoke scripts against isolated environments before merge.

## Authorization and standalone Control Center — explicit limitation

**A URL under /admin is not an admin authorization boundary.** This move is a UI/route relocation inside `solana-launcher`; it does not grant the product app the separate `admin-site` session. TG Invite retains its backend subscriber/owner-scoped access checks. X/TG operations retain their native API guards. This is **not a completed cross-application SSO migration**.

The separate Python `admin-site` already has its own X Collector and TG Collector surfaces with different capabilities. It does not currently host the full React TG Invite workspace. Do not iframe the product workspace, forward administrator cookies, expose client tokens, or proxy Telegram sessions to simulate full parity. An actual move into standalone `admin-site` needs an explicit identity and permission contract, a server-side same-origin backend-for-frontend for permitted actions, CSRF protection, auditing, operator approval for external actions, and independent browser/security tests.

## Rollback

Revert this UI commit to restore the original Settings tabs and routes. No data migration or runtime change is required. Verify the migrated route UI and authorization behavior in a disposable environment before enabling production access.
