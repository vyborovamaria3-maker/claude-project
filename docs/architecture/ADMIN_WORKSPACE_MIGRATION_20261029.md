# Standalone admin collector migration — PR #204

## Result and boundary

TG Invite, TG Collector and X Collector are rendered exclusively by the separate Python `admin-site`, at `/collectors/tg-invite`, `/collectors/tg-collector` and `/collectors/x-collector`. Product Settings and the main sidebar contain no operational collector tabs or administration hub. Existing X Registry is a separate module and is retained.

The admin build imports the original React components from `solana-launcher`; no collector implementation, database, encrypted session, queue or Telegram vault is copied. The Python server serves a compiled native UI, not an iframe. Existing database-editor and TG overview screens remain available and are explicitly distinguished from the full workspaces.

## Compatibility routes

The product app's former `/admin`, `/admin/x-collector`, `/admin/tg-collector`, `/admin/tg-invite`, `/tg-collector`, `/tginvite`, `/settings/tginvite`, `/launch/tginvite` and `/trade/tginvite` URLs return a server-side 307 to the corresponding standalone workspace. Settings query tabs `xcollector`, `tgcollector`, `tginvite` also redirect, retaining other query parameters. Set server-only `ADMIN_SITE_URL` to an HTTPS origin (loopback HTTP permitted for local development). Missing or invalid configuration returns 404; the product app never falls back to rendering a collector. The proxy produces the redirect before Next starts streaming its app shell; page-level redirects are defense in depth.

## Authentication and existing identity

- Workspace pages and every admin bridge API require the existing Control Center HttpOnly session, including revocation checks. Existing MFA and reauthentication middleware covers API actions.
- Every mutation requires the exact admin origin and rejects cross-site requests. Bridge requests have a fixed method/path allowlist, bounded bodies/responses, fixed local destinations, a timeout and no automatic retries. Browser bearer tokens, owner IDs, product cookies, forwarding headers and upstream Set-Cookie headers are not forwarded.
- TG Invite uses `ADMIN_TGINVITE_ACCESS_TOKEN`, an operator-supplied JWT for an existing active product superuser. Identity and owner storage continue to come from the original backend. All Control Center access uses that explicitly configured single operator identity; there is no implicit ownership transfer, SSO, identity creation or token renewal. Changing it changes which owner's existing vault/jobs are accessible. Tokens never enter client bundles or browser storage.
- X APIs now verify an active backend superuser for remote/production requests; an ordinary subscription is insufficient. TG Invite additionally checks the same role outside isolated loopback development. Both preserve their prior local development tools. TG Collector keeps its token, loopback, same-origin and production-404 guards.
- Mutation auditing records method, module and status only. An audit-storage failure after a completed action preserves the original result to avoid prompting duplicate actions.
- X session registration now uses the installed Node/tsx CLI directly, with a platform-neutral path and optional argument defaults; no shell or npx download handles credentials.

## Build and verification

From repository root after installing locked `solana-launcher` dependencies with `npm ci --legacy-peer-deps`:

```
node solana-launcher/node_modules/vite/bin/vite.js build --configLoader native --config admin-site/ui/vite.config.mjs
node admin-site/tests/collector-workspaces-browser.mjs
python -m unittest discover -s admin-site/tests -v
```

The admin Dockerfile builds the UI in a Node stage and copies the generated assets into Python runtime. Compose now uses the repository root as build context. Generated UI assets are ignored by Git. The predeploy gate builds/types-checks the UI, runs browser fixtures and role/redirect/session-registration tests, then builds the product and tests its actual production HTTP responses. Browser fixtures cover X outage recovery, queue states, worker state, reconciliation guards, metrics, TG stop/start and graph/evidence, all 16 original TG Invite tabs, owner identity and same-origin TeraGram calls. No real X or Telegram actions are performed.

## Remaining rollout prerequisites — not verified by offline tests

1. `ADMIN_COLLECTOR_API_ORIGIN` defaults to `http://127.0.0.1:3100`; `ADMIN_COLLECTOR_BACKEND_ORIGIN` defaults to `http://127.0.0.1:8000`. Only loopback HTTP origins are accepted. Existing local Next API runtime and backend must be reachable from the admin process's own network namespace. A Docker container's loopback is not its host's loopback. The current production Compose does not provision this local operational runtime; container/host connectivity remains a rollout blocker. No public proxy or production TG guard bypass was added.
2. Supply the existing TG collector token, databases, workers and a valid `ADMIN_TGINVITE_ACCESS_TOKEN` for the intended existing owner. An expired JWT fails closed and needs operator rotation. Credentials and live stores were not loaded or changed during this review.
3. Five admin PostgreSQL integration tests require `ADMIN_STATE_TEST_DSN`; local offline tests skip them. CI provisions its own disposable PostgreSQL.
4. Real collector histories, Telegram login/vault continuity, invitation delivery, actual X publishing and sustained worker behavior need a separate disposable integration run. Existing unavailable/scheduled features are not made available by moving their UI.
5. Review the latest PR-head CI, including the new standalone UI gate. No merge or deployment is part of this work.

## Rollback

Revert the PR commits and rebuild both applications. There are no schema migrations, data copies or session re-encryption to undo. Reverting only the UI does not change existing databases or jobs.