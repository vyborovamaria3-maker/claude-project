# Production deploy without GitHub Actions

Production no longer depends on the self-hosted GitHub Actions runner. The server builds the frontend, backend and Telegram bot directly from the checked-out repository and then runs the existing backup, migration, healthcheck and rollback flow.

## One-time server setup

The production server needs a clean checkout of this private repository at `/opt/claude-project` and read access to GitHub (prefer an SSH deploy key with read-only repository access).

```bash
sudo mkdir -p /opt/claude-project
sudo chown -R "$USER":"$USER" /opt/claude-project

git clone git@github.com:vyborovamaria3-maker/claude-project.git /opt/claude-project
cd /opt/claude-project
git switch main
```

The existing production secrets remain outside Git in:

- `/opt/potapoff-deploy/.env.server`
- `/opt/potapoff-deploy/backend.env`

Do not copy these files into the repository.

Docker Engine with the Compose plugin is required.

## Deploy current `main`

```bash
cd /opt/claude-project
bash solana-launcher/scripts/deploy-production-local.sh
```

The script:

1. refuses to deploy from a dirty server checkout;
2. fetches `main` and only accepts a fast-forward update;
3. copies the production Compose/Nginx/Prometheus configuration to `/opt/potapoff-deploy`;
4. resolves `BACKEND_API_KEY` from `.env.server` or `backend.env` without exposing the rest of `backend.env` to the frontend;
5. builds backend, frontend and Telegram bot images locally on the server;
6. creates the existing production backup;
7. recreates the stack, runs database migrations and restarts Nginx;
8. runs `healthcheck-production.sh`, including `/api/miniapp/config`;
9. switches back to the previous local image tag if deployment or healthcheck fails.

## Deploy another branch temporarily

```bash
POTAPOFF_DEPLOY_BRANCH=branch-name \
  bash /opt/claude-project/solana-launcher/scripts/deploy-production-local.sh
```

Use `main` for normal production deployments.

## Mini App regression check

After deployment this endpoint must return HTTP 200 and subscription configuration rather than `Subscription settings are temporarily unavailable`:

```bash
curl -fsS https://potapoff.fun/api/miniapp/config
```

The normal healthcheck performs this check automatically.

## GitHub Actions

`.github/workflows/potapoff-production.yml` is intentionally manual-only. Pushes to `main` do not start production deployment jobs. GitHub remains the source repository; production execution happens on the server.
