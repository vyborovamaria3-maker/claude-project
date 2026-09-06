# Vibe Audit Security Remediation Plan

Date: 2026-09-06
Scope: `vyborovamaria3-maker/claude-project`, with the confirmed high-risk findings concentrated in `solana-launcher/`.
Reference methodology: `haraldalder-vibemogger/vibe-audit` categories (secrets/env, authentication and authorization, rate limits, CORS/debug, JWT, AI cost controls, Docker/default credentials, exposed services, dependencies, and manual review of sensitive endpoints).

## Executive status

| Finding | Severity | Remediation | Status |
| --- | --- | --- | --- |
| Docker services exposed directly on 5432/6379/5672/15672/8000/3000/9090 | Critical/High | Remove host port publishing for internal services; leave nginx as the ingress | FIXED IN SOURCE |
| Default Postgres/RabbitMQ credentials and unauthenticated Redis | High | Require runtime passwords; enable Redis `requirepass`; remove committed runtime defaults | FIXED IN SOURCE |
| Compose loaded `backend/.env.example` as runtime configuration | Critical contributor | Require untracked `backend/.env`; example is intentionally non-runnable | FIXED IN SOURCE |
| Development password-provisioning bypass using fixed `X-Dev-Internal: miniapp-subscription` | Critical/High | Remove fixed-header bypass; require configured `X-API-Key`; add middleware defense in depth | FIXED IN SOURCE |
| Predictable development admin automatically created/reset on startup | Critical contributor | Never auto-bootstrap dev/test admin; never silently promote an existing account or reset its password | FIXED IN SOURCE |
| Telegram callback constructed bearer token in redirect query | Medium/Hardening | Stop constructing token-bearing URL; keep credentials out of redirect URL | FIXED IN SOURCE |
| Historically committed Supabase service-role-style credential | High if credential was real | Rotate at provider and purge from Git history | EXTERNAL ACTION REQUIRED |
| Dependency vulnerability freshness | Coverage gap | Run `npm audit` / `pip-audit` from a clean checkout and remediate actionable findings | VERIFY IN CI |
| Live internet exposure of old service ports | Verification gap | Authorized owner-only external reachability check after deployment | OWNER VERIFICATION |

## Source changes applied

### 1. Docker and infrastructure isolation

`solana-launcher/docker-compose.yml` is now secure-by-default:

- Postgres, Redis, RabbitMQ, backend, frontend, and Prometheus no longer publish their service ports to the host.
- Only nginx remains a public host ingress on port 80.
- Postgres and RabbitMQ passwords are required via Compose environment interpolation; no known password is embedded in the Compose file.
- Redis now requires a password and its health check authenticates.
- Backend and Celery connect to internal service DNS names and authenticated URLs.
- Backend/worker load `backend/.env`, not the committed `.env.example`.
- Compose defaults the application services to `ENVIRONMENT=production` and `DEBUG=false`.
- Public frontend URL must be explicitly configured.

Deployment secrets are split intentionally:

- `solana-launcher/.env`: Compose/infrastructure credentials and public deployment URLs.
- `solana-launcher/backend/.env`: application/backend secrets.

Both real files are ignored by git. Their committed `.env.example` files contain no usable secrets.

### 2. Legacy paid-password provisioning

`/api/v1/auth/register-password` no longer trusts any fixed source-controlled development header.

Rules after remediation:

- production: endpoint remains hidden with 404;
- development/test: `BACKEND_API_KEY` must be configured;
- caller must provide that secret as `X-API-Key`;
- missing configuration fails closed;
- invalid key fails closed;
- constant-time comparison is used;
- the endpoint repeats the check even though application middleware already enforces it.

The old `X-Dev-Internal: miniapp-subscription` path must never be restored.

### 3. Administrator bootstrap

Startup no longer creates a predictable administrator in development/test.

Production bootstrap behavior is fail-closed:

- strong production settings are validated before startup;
- a missing configured admin may be created once;
- if the configured admin email already belongs to a non-superuser or inactive account, startup refuses automatic privilege escalation;
- an existing superuser password is never reset from an environment variable on every restart.

Admin credential rotation should be performed through an explicit administrative procedure rather than implicit application startup behavior.

### 4. Telegram redirect credential handling

The Telegram callback now returns the frontend URL without adding the access token to query parameters. The access token remains in the response body as required by the existing API contract. `TelegramCallbackResponse` also keeps its existing query/fragment stripping validator as a second layer of defense.

A future session-hardening project can move browser authentication to Secure/HttpOnly/SameSite cookies or an explicit one-time authorization-code exchange, but the confirmed URL-token construction is removed by this remediation.

## Required deployment preparation

Before deploying this branch, create local secret files from the templates and fill every required value.

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
- `ADMIN_SESSION_SECRET` (>= 32 strong characters)
- `BACKEND_API_KEY` (>= 32 strong characters)
- `SUBSCRIPTION_PASSWORD_ENCRYPTION_KEY` (>= 32 strong characters and different from `SECRET_KEY`)
- subscription internal/admin keys when the corresponding `REQUIRE_*` flags are enabled
- Telegram/API provider credentials used by the deployment

Never copy generated secrets into issues, PR bodies, chat messages, logs, or committed example files.

## Validation plan

### Phase A — deterministic source checks

Acceptance criteria:

- no `X-Dev-Internal` fixed authorization path;
- no `?token=<bearer>` construction in Telegram redirect code;
- no committed `ChangeMe123!`, `guest/guest`, or `potapoff:potapoff` runtime credential path;
- no host publishing for database/cache/broker/backend/frontend/Prometheus services;
- `.env.example` is never used as runtime `env_file`.

### Phase B — backend regression tests

Run from `solana-launcher/backend`:

```bash
pytest -q tests/test_auth.py tests/test_auth_response_security.py tests/test_admin_bootstrap_security.py tests/test_production_admin_config.py
```

Then run the complete backend suite:

```bash
pytest -q
```

Acceptance criteria:

- legacy fixed dev header receives 403;
- configured backend API key is required for non-production provisioning;
- Telegram redirect has no query or fragment and contains no access token;
- existing normal user cannot be silently promoted to admin;
- existing superuser password is not reset at startup;
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

### Phase D — dependency scanning

Run the repository's existing security-gate workflows. From a clean checkout also run the package-manager audits appropriate to each lockfile, including backend `pip-audit` and the repository npm audit jobs.

Acceptance criteria:

- no unresolved critical/high dependency issue with a supported fix;
- exceptions, if unavoidable, are documented with package, advisory, exposure analysis, owner, and expiry date.

### Phase E — Strix / independent retest

Run the existing fail-closed Strix workflow after GitHub Actions runners are functioning. The Strix run must have `run.json.status == completed`; incomplete runs are not evidence of a clean result.

Acceptance criteria:

- confirmed findings are reproduced before patch when possible and no longer reproduce after patch;
- new findings are manually triaged before acceptance;
- scan evidence/SARIF is retained.

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

Previous security workflow attempts failed before runner allocation. Restore Actions runner/billing/availability, then rerun security gates and Strix. A workflow with zero executed steps is not a passing security test.

### Authorized external exposure verification

Only the repository/system owner should authorize live reachability testing. After deployment, verify from outside the trusted network that only intended ingress is reachable. Do not perform unsolicited scanning against third-party infrastructure.

## Definition of done

This remediation is complete only when all of the following are true:

- source fixes in this document are merged;
- deployment uses newly generated runtime secrets, not examples;
- backend and Compose regression checks pass;
- dependency audits pass or have time-bounded documented exceptions;
- Strix completes successfully and findings are triaged;
- any historical real credential has been rotated and purged;
- owner-authorized external verification confirms internal service ports are not exposed.

Until the external/manual items are confirmed, report the project as **source-hardened with operational verification outstanding**, not as "fully secure".
