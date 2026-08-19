# Production release readiness — 2026-08-19

Target branch: `main`
Release preparation branch: `release/prepare-full-production-20260819`

## Scope

This release path covers all production-capable services that contain changes after the previously confirmed production SHA:

- `solana-launcher` frontend, FastAPI backend and Telegram bot;
- `solana-subscription-service` API, web and bot plus PostgreSQL/Redis;
- `telegram-miniapp/backend-new` legacy payment backend;
- Intelligence verification and production configuration gates.

PR #2 and PR #3 are intentionally excluded and must remain closed/unmerged.

## Release gate

Run `.github/workflows/full-production-release.yml` from `main` and type `DEPLOY` only after all blockers below are closed.

The workflow executes:

1. unified Release Readiness on the exact release SHA;
2. existing POTAPoff production deployment;
3. Solana subscription production deployment;
4. legacy Mini App backend deployment;
5. health checks after every deployment stage;
6. conservative passive production DAST before the release is marked complete.

The workflow is intentionally manual. Merge to `main` is not sufficient approval for the full multi-service release.

## GitHub production secrets required

The `production` environment must provide:

- `SERVER_HOST`
- `SERVER_PORT`
- `SERVER_USER`
- `SERVER_SSH_KEY`
- `SERVER_SSH_KNOWN_HOSTS`
- `GHCR_USERNAME`
- `GHCR_TOKEN`

Existing POTAPoff production secrets required by `potapoff-production.yml` must remain configured.

## GitHub production variables required

For the subscription web build:

- `SOLSUB_PUBLIC_API_URL`
- `SOLSUB_PUBLIC_WEB_URL`
- `SOLSUB_TELEGRAM_BOT_USERNAME`
- `SOLSUB_SOLANA_CLUSTER`
- `SOLSUB_PUBLIC_RPC_ENDPOINT`
- `SOLSUB_TREASURY_WALLET`

For post-deploy DAST:

- `PRODUCTION_PUBLIC_URL` — the authorized public HTTPS target for the production passive scan.

`NEXT_PUBLIC_*` values are compiled into the public Next.js bundle. Do not put private credentials into them.

## Self-hosted production runner requirements

The production runner must have:

- Docker Engine and Docker Compose v2;
- SSH client and `scp`;
- `curl`/standard shell utilities;
- `webscan` installed and callable from `PATH` for the conservative production DAST step.

Production DAST fails closed when `webscan` is unavailable. `ghostmap` and `xhunter` are intentionally disabled in the production profile and remain staging/lab tools.

## Server-side files required

### Subscription stack

Create `/opt/solsub-deploy/.env` with production values before the first deployment. It must include the application settings from `solana-subscription-service/.env.example`, plus strong values for at least:

- `POSTGRES_PASSWORD`
- `REDIS_PASSWORD`
- Telegram/auth/JWT secrets required by the service
- Solana/Helius production configuration

The deployment workflow keeps this file on the server, never uploads it from GitHub, and enforces mode `0600`.

### Legacy Mini App backend

Create `/opt/legacy-miniapp-deploy/.env.production` from `telegram-miniapp/backend-new/.env.example` and set:

- `NODE_ENV=production`
- `FRONTEND_URL` to the real HTTPS frontend
- `TELEGRAM_BOT_TOKEN` to the rotated production token
- `HELIUS_API_KEY`
- `HELIUS_WEBHOOK_SECRET` with at least 32 random characters
- `MERCHANT_WALLET`
- production Solana RPC URL

The Docker Compose deployment overrides the SQLite path to the persistent `/data/miniapp.db` volume.

## Database safety

### Subscription PostgreSQL

Before migration/deploy the workflow:

- starts PostgreSQL and Redis;
- creates a compressed `pg_dump` under `/opt/solsub-deploy/backups/`;
- runs `prisma migrate deploy` exactly once for the release;
- starts API/web/bot only after migration succeeds;
- restores the previous image set if post-deploy health checks fail.

Production seed is no longer executed automatically on every container start.

### Legacy SQLite

Before schema synchronization the workflow copies the existing SQLite database to `/opt/legacy-miniapp-deploy/backups/` when it exists. Prisma `db push` runs without `--accept-data-loss`, so destructive schema changes fail closed instead of being accepted automatically.

## Blocking external security actions

Do not run the full production workflow until both previously exposed credentials are rotated at their providers:

1. Telegram bot credential from SEC-012;
2. external API credential from SEC-013.

After rotation:

- update the corresponding GitHub/server secret stores;
- verify the old credentials are invalid;
- do not commit the replacement values to Git.

These are provider-side operations and cannot be completed by repository changes alone.

## Residual accepted risk

The documented `bigint-buffer` advisory exception remains accepted only until **2026-10-01**. `Release Readiness` and `Security Gates` must reject any other HIGH/CRITICAL npm advisory. Migration away from the affected legacy Solana dependency chain is required before the exception expires.

## Post-deploy validation

The full release automatically requires the passive production `webscan`. After all stages are healthy also:

- verify public landing and `/dashboard`;
- verify FastAPI `/health` and `/ready`;
- verify subscription API `/health` and web root;
- verify legacy backend `/health`;
- review the uploaded production DAST artifact;
- run authenticated staging DAST/BOLA checks before treating the security audit as fully closed;
- record the deployed Git SHA and backup paths.

A failed or unavailable DAST check is `PENDING`, not `PASSED`.
