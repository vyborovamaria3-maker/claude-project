# One-command production deploy

The server-local deploy path is the Actions-free fast path for POTAPoff. It reuses the same rollback-protected production rollout as the GHCR workflow instead of maintaining a second deployment implementation.

## One-time install

Run on the production server after this change is present in `/opt/claude-project`:

```bash
sudo install -m 0755 /opt/claude-project/solana-launcher/scripts/potapoff-deploy /usr/local/bin/deploy
```

After that, a normal deployment is:

```bash
deploy
```

The command deploys `main` by default. Override only for an explicitly planned validation environment:

```bash
POTAPOFF_DEPLOY_BRANCH=my-branch deploy
```

## What `deploy` does

Before it touches the running stack it:

1. takes an exclusive deployment lock so two deploys cannot run concurrently;
2. requires a clean production checkout;
3. fetches the configured branch and updates with fast-forward only;
4. validates all deployment shell scripts with `bash -n`;
5. validates the Nginx configuration;
6. installs the reviewed Compose/Nginx/Prometheus/deploy files into `/opt/potapoff-deploy`;
7. validates production Compose and Control Center Compose;
8. builds immutable exact-SHA backend and frontend images locally using the production Dockerfiles;
9. builds the Telegram bot image when the bot is configured;
10. checks Python bytecode compilation and requires a single Alembic head inside the new backend image;
11. builds the Control Center image before production is changed;
12. stages the Control Center source without server-only secrets/configuration.

Only after those checks pass does it call the canonical `deploy-production.sh` with `POTAPOFF_LOCAL_IMAGES=1`.

The canonical rollout then performs the production backup, stops background writers, runs Alembic with the new backend image, switches services, starts the Twitter discovery daemon, verifies the Control Center -> backend credential path, runs the full production healthcheck, and automatically rolls back on failure.

If the target SHA is already deployed, `deploy` does not rebuild or restart the stack; it runs the production healthcheck and exits with `NO_CHANGES`.

## Expected success markers

A successful run ends with markers equivalent to:

```text
LOCAL_RELEASE_IMAGES_OK tag=<sha>
ADMIN_READY_OK
TWITTER_ADMIN_BACKEND_OK
TWITTER_SETTINGS_WRITE_SMOKE_OK
HEALTHCHECK_OK ... frontend_build=verified
ADMIN_ROUTE_OK ...
DEPLOYMENT_OK tag=<sha>
ONE_COMMAND_DEPLOY_OK tag=<sha>
```

## Important boundary: memecoin-intelligence / Qwen

`memecoin-intelligence` is currently a separate production stack with its own PostgreSQL/Redis volumes and is not owned by the POTAPoff production Compose deployment. The one-command deploy intentionally does not recreate that stack until its server-only environment, persistent-volume backup and rollback contract are folded into the production runbook. The existing predeploy workflow still validates its typecheck/tests/build/Compose.

Do not describe a POTAPoff deploy as updating the standalone `memecoin-intelligence` stack until that integration is implemented.
