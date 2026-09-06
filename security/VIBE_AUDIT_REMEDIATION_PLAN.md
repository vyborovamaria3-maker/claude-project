# Vibe Audit Security Remediation Plan

Date: 2026-09-06
Scope: `vyborovamaria3-maker/claude-project`, with the confirmed high-risk findings concentrated in `solana-launcher/`.
Reference methodology: `haraldalder-vibemogger/vibe-audit` categories (secrets/env, authentication and authorization, rate limits, CORS/debug, JWT, AI cost controls, Docker/default credentials, exposed services, dependencies, and manual review of sensitive endpoints).

## Executive status

| Finding | Severity | Remediation | Status |
| --- | --- | --- | --- |
| Docker services exposed directly on database/cache/broker/backend/frontend/metrics ports | Critical/High | Remove host port publishing for internal services; leave nginx as the ingress | FIXED IN SOURCE |
| Default infrastructure credentials and unauthenticated Redis | High | Require runtime passwords; enable Redis authentication; remove credential-bearing application defaults | FIXED IN SOURCE |
| Compose loaded `backend/.env.example` as runtime configuration | Critical contributor | Require untracked `backend/.env`; examples contain no usable runtime secrets | FIXED IN SOURCE |
| Development password-provisioning bypass using a fixed source-controlled internal header | Critical/High | Remove fixed-header bypass; require the dedicated subscription credential; add middleware defense in depth | FIXED IN SOURCE |
| Fixed development-header bypass on subscription settings/order endpoints | Critical/High | Remove the header bypass and require scoped subscription/admin API keys | FIXED IN SOURCE |
| Predictable development admin automatically created/reset on startup | Critical contributor | Never auto-bootstrap dev/test admin; never silently promote/reset an account; block startup if a deployed admin still uses the former known default password | FIXED IN SOURCE |
| Telegram callback constructed bearer token in redirect query | Medium/Hardening | Stop constructing token-bearing URL; keep credentials out of redirect URL | FIXED IN SOURCE |
| Historically committed Supabase service-role-style credential | High if credential was real | Rotate at provider and purge from Git history | EXTERNAL ACTION REQUIRED |
| Dependency vulnerability freshness | Coverage gap | Run npm/pip dependency audits from a clean checkout and remediate actionable findings | VERIFY WHEN RUNNERS RETURN |
| Live internet exposure of old service ports | Verification gap | Authorized owner-only external reachability check after deployment | OWNER VERIFICATION |

## Source changes applied

### 1. Docker and infrastructure isolation

`solana-launcher/docker-compose.yml` is now secure-by-default:

- Postgres, Redis, RabbitMQ, backend, frontend, and Prometheus no longer publish their service ports to the host.
- Only nginx remains a normal public host ingress on port 80.
- Postgres and RabbitMQ passwords are required via Compose environment interpolation; no known password is embedded in the Compose file.
- Redis now requires a password and its health check authenticates.
- Backend and Celery connect to internal service DNS names and authenticated URLs.
- Backend/worker load `backend/.env`, not the committed `.env.example`.
- Compose defaults application services to `ENVIRONMENT=production` and `DEBUG=false`.
- Public frontend URLs must be explicitly configured.
- The Compose `.env.example` leaves required secrets blank, so a copied template fails closed until real values are supplied.

Deployment secrets are split intentionally:

- `solana-launcher/.env`: Compose/infrastructure credentials and public deployment URLs.
- `solana-launcher/backend/.env`: application/backend secrets.

Both real files are ignored by git.

### 2. Application configuration defaults

`Settings` no longer embeds usable database/broker/admin credentials:

- development database fallback is a local SQLite file;
- Redis/Celery development fallbacks point to loopback only;
- default debug mode is disabled;
- admin password and standalone admin-session secret have no committed usable value;
- non-production may derive its local session signing value from the already-required application secret when no separate value is supplied;
- production requires a distinct admin-session signing secret and JWT/application signing secret.

Production Compose still injects explicit authenticated service URLs, so these local fallbacks are not used for normal deployment.

### 3. Legacy paid-password provisioning and subscription authorization

`/api/v1/auth/register-password` no longer trusts any fixed source-controlled development header.

Rules after remediation:

- production: endpoint remains hidden with 404;
- development/test: `SUBSCRIPTION_INTERNAL_KEY` must be configured;
- caller must provide that secret as `X-API-Key`;
- `BACKEND_API_KEY` is intentionally rejected because it is scoped to intelligence/backend operations, not subscription provisioning;
- missing configuration fails closed;
- invalid key fails closed;
- constant-time comparison is used;
- the endpoint repeats the check even though application middleware already enforces it.

The same fixed `X-Dev-Internal: miniapp-subscription` bypass was also removed from the subscription settings/order API. Checkout/order operations now require `SUBSCRIPTION_INTERNAL_KEY`; settings administration requires `SUBSCRIPTION_ADMIN_KEY`; settings reads accept only the explicitly scoped internal/admin keys.

The previous fixed-header authorization path must never be restored.

### 4. Administrator bootstrap

Startup no longer creates a predictable administrator in development/test.

Production bootstrap behavior is fail-closed:

- strong production settings are validated before startup;
- a missing configured admin may be created once;
- if the configured admin email already belongs to a non-superuser or inactive account, startup refuses automatic privilege escalation;
- an existing superuser password is never reset from an environment variable on every restart;
- if an existing configured superuser still verifies against the former source-controlled default admin password, production startup is refused until the credential is explicitly rotated.

This last check handles upgrades from an older deployment whose database may already contain the previously predictable administrator credential. Admin credential rotation should be performed through an explicit administrative procedure rather than implicit password resets on every application startup.

### 5. Telegram redirect credential handling

The Telegram callback now returns the frontend URL without adding the access token to query parameters. The access token remains in the response body as required by the existing API contract. `TelegramCallbackResponse` also keeps its existing query/fragment stripping validator as a second layer of defense.

A future session-hardening project can move browser authentication to Secure/HttpOnly/SameSite cookies or an explicit one-time authorization-code exchange, but the confirmed URL-token construction is removed by this remediation.

### 6. Regression enforcement

The repository `Security Gates` workflow includes the auth, admin-bootstrap, runtime-default, redirect, subscription-key-separation, and Compose-isolation security regression tests so future PRs cannot silently restore these paths.

## Required deployment preparation

Before deploying, create local secret files from the templates and fill every required value.

### `solana-launcher/.env`

Use independent URL-safe random values. Hex strings avoid URI-encoding problems in generated connection URLs.

Recommended generation command for each service password:

```bash
openssl rand -hex 32
```

Required at minimum:

- `POSTGRES_PASSWORD`
- `REDIS_PASSWORD`
- `RABBITMQ_PASSWORD`
- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_FRONTEND_URL`

### `solana-launcher/backend/.env`

Required production security values include:

- `SECRET_KEY` (>= 32 strong characters; random hex recommended)
- `ADMIN_PASSWORD` (>= 16 strong characters)
- `ADMIN_SESSION_SECRET` (>= 32 strong characters and different from `SECRET_KEY`)
- `BACKEND_API_KEY` (>= 32 strong characters)
- `SUBSCRIPTION_PASSWORD_ENCRYPTION_KEY` (>= 32 strong characters and different from `SECRET_KEY`)
- `SUBSCRIPTION_INTERNAL_KEY` when checkout/order/internal subscription access is enabled
- `SUBSCRIPTION_ADMIN_KEY` when main-admin subscription settings access is enabled
- Telegram/API provider credentials used by the deployment

Use independent random values for `BACKEND_API_KEY`, `SUBSCRIPTION_INTERNAL_KEY`, and `SUBSCRIPTION_ADMIN_KEY`; they are separate trust domains and must not be reused.

If production refuses startup because it detects the former default administrator credential in the database, rotate that account password through an explicit trusted administrative/database procedure before bringing the service online.

Never copy generated secrets into issues, PR bodies, chat messages, logs, or committed example files.

## Validation plan

### Phase A — deterministic source checks

Acceptance criteria:

- no fixed source-controlled header can authorize password provisioning or subscription operations;
- the broader backend/intelligence key cannot authorize subscription provisioning;
- no bearer token is constructed into the Telegram redirect URL;
- no usable default service/admin credential is present in active runtime configuration;
- no host publishing for database/cache/broker/backend/frontend/Prometheus services;
- `.env.example` is never used as runtime `env_file`;
- copying either example env file unchanged cannot produce a valid production deployment.

### Phase B — backend regression tests

Run from `solana-launcher/backend`:

```bash
pytest -q \
  tests/test_auth.py \
  tests/test_auth_response_security.py \
  tests/test_admin_bootstrap_security.py \
  tests/test_runtime_security_defaults.py \
  tests/test_production_admin_config.py \
  tests/test_subscription_internal_access.py \
  tests/test_subscription_compose_security.py
```

Then run the complete backend suite:

```bash
pytest -q
```

Acceptance criteria:

- legacy fixed development authorization is rejected;
- configured `SUBSCRIPTION_INTERNAL_KEY` is required for non-production subscription provisioning;
- `BACKEND_API_KEY` cannot authorize subscription provisioning;
- checkout/admin subscription credentials remain privilege-separated;
- Telegram redirect has no query or fragment and contains no access token;
- existing normal user cannot be silently promoted to admin;
- existing superuser password is not reset at startup;
- a pre-existing superuser carrying the former known default password blocks startup until rotation;
- runtime defaults contain no embedded service/admin credentials;
- Compose templates preserve internal-service isolation and required-secret behavior;
- production security validation still passes.

### Phase C — Compose validation

After creating the two local `.env` files:

```bash
docker compose config
```

Then start the deployment and confirm:

```bash
docker compose up -d --build
docker compose ps
```

Acceptance criteria:

- database/cache/broker/backend/frontend/Prometheus are reachable only on the Compose network unless an explicit trusted administrative override is added;
- nginx is the only normal host ingress;
- backend starts in production mode with debug disabled;
- Redis rejects unauthenticated requests;
- health/readiness checks succeed.

### Phase D — dependency and secret scanning

When GitHub-hosted runners are available again, rerun the repository `Security Gates` workflow. It contains current-tree/diff/history secret scanning, npm security policies, the backend security regression set above, and `pip-audit`.

Acceptance criteria:

- every job actually receives a runner and executes steps;
- no unresolved critical/high dependency issue with a supported fix;
- no newly introduced secret finding;
- exceptions, if unavoidable, are documented with package/advisory, exposure analysis, owner and expiry date.

A workflow record with `runner_id: 0` and zero executed steps is infrastructure evidence only; it is neither a pass nor a code/test failure.

### Phase E — independent retest

Repeat the `vibe-audit` manual/deterministic review against the merged tree. If an independent scanner such as Strix is installed or reintroduced later, require its run to finish successfully before treating its output as evidence; an incomplete scan is not a clean result.

Acceptance criteria:

- confirmed findings no longer reproduce;
- new findings are manually triaged before acceptance;
- evidence is retained with the release/security record.

## External/manual actions that source code cannot complete

### Historical Supabase credential

If the previously committed service-role-style credential ever pointed to a real project, assume compromise even though it is absent from the current working tree.

Required owner actions:

1. Rotate/revoke the credential in Supabase.
2. Update the deployment secret store with the replacement.
3. Purge the old value from all reachable Git history using an approved history-rewrite procedure.
4. Invalidate old clones/caches or instruct collaborators to re-clone after the rewrite.
5. Confirm the old credential can no longer authenticate.

Do not mark this item complete based only on deleting the file from `main`.

### GitHub Actions execution availability

Current PR workflow jobs are failing before any job steps execute: GitHub reports no allocated runner and an empty step list. Restore GitHub Actions runner/billing/availability, then rerun the security gates. A job with no executed steps is not a passing security test and should not block source remediation when merge policy permits an explicitly documented manual review.

### Authorized external exposure verification

Only the repository/system owner should authorize live reachability testing. After deployment, verify from outside the trusted network that only intended ingress is reachable. Do not perform unsolicited scanning against third-party infrastructure.

## Definition of done

Source remediation is complete when the reviewed source fixes in this document are merged. Operational security closure additionally requires all of the following:

- deployment uses newly generated runtime secrets, not examples;
- backend and Compose regression checks actually execute and pass once runners are restored;
- dependency/secret audits actually execute and pass or have time-bounded documented exceptions;
- an independent post-fix audit is completed and triaged;
- any historical real credential has been rotated and purged;
- any legacy deployed default administrator credential has been rotated;
- owner-authorized external verification confirms internal service ports are not exposed.

Until the external/manual items are confirmed, report the project as **source-hardened with operational verification outstanding**, not as "fully secure".
