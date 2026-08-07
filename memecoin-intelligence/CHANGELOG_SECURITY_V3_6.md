# Security hardening v3.6 — isolated changes

All changes in this pass were made with backward compatibility as the default. Opt-in security features remain disabled until explicitly enabled.

## 1. API key comparison safety
- Fixed `timingSafeEqual` length mismatch exception.
- File: `src/server/security/auth.ts`.
- Existing valid/invalid key semantics preserved.

## 2. Security headers (opt-in)
- Added `src/server/security/headers.ts`.
- Added `SECURITY_HEADERS_STRICT=false` by default.
- With the flag disabled, Helmet receives the same legacy configuration: `{ contentSecurityPolicy: false }`.

## 3. RBAC foundation and enforcement (opt-in)
- Added `accessPolicy.ts`, `accessControl.ts`, `rbac.ts`.
- Added admin/user API-key roles.
- Legacy `INTERNAL_API_KEY` remains supported and maps to admin.
- Admin-only enforcement applies to token mutation routes only when `SECURITY_RBAC_ENABLED=true`.
- With RBAC disabled, old route behavior is preserved.

## 4. Queue consistency
- Analysis and Telegram AI enqueue failures now mark persisted runs as failed instead of leaving them permanently queued.
- Successful enqueue path is unchanged.

## 5. Analysis worker status correctness
- A real `{ status: 'error' }` search result is now handled by the existing failure path and persisted as failed.

## 6. Telegram AI cache isolation
- Cache identity now includes inference mode, endpoint, token limit and temperature.
- Cached AI results are schema/evidence validated before being returned.
- Invalid/stale cache data becomes a cache miss instead of a response.

## 7. Production emitted-import compatibility
- Added `scripts/rewrite-server-imports.mjs`.
- It rewrites only compiled `dist` JavaScript aliases from `@/...` to relative imports after `tsc`.
- Source imports are untouched.

## 8. Docker compatibility/security
- Restored base Compose API/worker/web commands to their working development commands.
- PostgreSQL and Redis remain bound to localhost on the host.
- API/worker container DB and Redis URLs now correctly address `postgres` and `redis` services instead of container-local `localhost`.
- Added Redis healthcheck and variable-aware PostgreSQL healthcheck.
- `.env.example` now contains consistent local/Docker credentials.

## Deliberately not forced in this pass
- JWT/OAuth user system.
- Database-backed user/session tables.
- Redis-backed Fastify rate-limit store.
- Production Docker image redesign.
- These require full dependency/runtime validation and are not enabled blindly because the current environment cannot install the project's npm dependencies or run Docker.
