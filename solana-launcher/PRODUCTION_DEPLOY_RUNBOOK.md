# POTAPoff Production Deploy Runbook

This runbook is the release gate for the production stack, including the Twitter/X registry and discovery daemon, Control Center, Mini App, TeraGram/Telegram services and Qwen-backed intelligence paths.

## 1. Non-negotiable preconditions

Do not merge or deploy if any item below is false.

- The release commit is on `main`.
- `main` has not moved since the reviewed PR base was validated.
- The PR was reviewed against the exact head SHA being merged.
- `POTAPoff predeploy gate` executed real runner steps and is green. A run with `steps=null`, no runner and no logs is infrastructure failure, not a passing validation.
- `Security Gates` executed real runner steps and is green.
- The post-merge `POTAPoff release images` workflow is green for the exact `main` SHA.
- GHCR contains exact-SHA images for `backend`, `frontend` and `telegram-bot`.
- The production deployment is dispatched from `main`; the workflow rejects any other ref.
- A working previous `.current-image-tag` exists unless this is an explicitly planned first deployment.

### Repository governance requirement

`main` should be protected with GitHub branch protection or a repository ruleset. At minimum:

- block direct pushes to `main`;
- require pull requests;
- require the five `POTAPoff predeploy gate` jobs to pass;
- require the relevant `Security Gates` jobs to pass;
- require branches to be up to date before merge;
- prevent bypass except for a documented emergency path.

If `main` is unprotected, the CI/deploy code is still fail-closed, but GitHub itself does not prevent someone from bypassing the merge gate.

### Self-hosted runner requirement

The workflows use a self-hosted runner by default so the release gate does not depend on paid GitHub-hosted minutes. Register a Linux runner for this repository with the `self-hosted` label, or set the repository variable `POTAPOFF_RUNNER` to a more specific label such as `potapoff-linux`.

The runner must have Docker, Docker Compose, Bash and Git available. The workflows install project dependencies through their existing setup steps. A queued workflow with no matching runner is not a passing validation.

To bootstrap an Ubuntu runner, copy `.github/scripts/install-self-hosted-runner.sh` to the server, generate a fresh repository runner token in GitHub, then run:

```bash
export RUNNER_TOKEN='<fresh repository runner registration token>'
sudo -E bash /tmp/install-self-hosted-runner.sh
```

## 2. Release image chain

`POTAPoff release images` runs only for `main` and depends on the reusable predeploy gate before it can publish anything.

For one commit SHA it builds and publishes:

- `ghcr.io/vyborovamaria3-maker/claude-project/backend:<sha>`
- `ghcr.io/vyborovamaria3-maker/claude-project/frontend:<sha>`
- `ghcr.io/vyborovamaria3-maker/claude-project/telegram-bot:<sha>`

Images include OCI source/revision labels and BuildKit SBOM/provenance attestations. The frontend is built with `NEXT_PUBLIC_BUILD_SHA=<sha>`; production health verifies the served build SHA against the deployment tag.

Never deploy a floating `latest` tag.

## 3. Server configuration invariants

Required deployment files live under `/opt/potapoff-deploy`:

- `.env.server`
- `backend.env`
- `docker-compose.production.yml`
- `scripts/backup-production.sh`
- `scripts/deploy-production.sh`
- `scripts/healthcheck-production.sh`
- `prometheus/prometheus.yml`

Control Center server-only configuration lives under `/opt/claude-project/admin-site` and is preserved across source releases:

- `.env`
- `.env.intelligence`
- `sources.json`
- `logs.json`

### Twitter crawler admin secret

`TWITTER_CRAWLER_ADMIN_KEY` must exist only in:

- `/opt/potapoff-deploy/backend.env`
- `/opt/claude-project/admin-site/.env`

It must **not** be present in `.env.server`, because `.env.server` is loaded after `backend.env` and would override the dedicated value, including with an empty assignment.

The deploy script:

- generates the key if neither server-only file has it;
- requires 32-256 URL-safe characters;
- aborts if backend/admin values differ;
- writes the same value to both server-only files.

## 4. What the production workflow does before switching traffic

The `POTAPoff production deploy` workflow:

1. rejects non-`main` dispatches;
2. reruns the reusable predeploy gate;
3. configures pinned-host SSH;
4. uploads deployment configuration;
5. logs the server into GHCR;
6. verifies exact-SHA release images exist;
7. uploads the Control Center source into a versioned staging directory only;
8. invokes `scripts/deploy-production.sh <GITHUB_SHA>`.

Staging the Control Center does not replace the active source. Source activation happens only inside the rollback-protected deploy script.

## 5. Backup gate

Before schema or application switching, `backup-production.sh` must succeed.

The backup contains:

- product PostgreSQL custom-format dump (`postgres.dump`);
- Control Center PostgreSQL custom-format dump (`admin-postgres.dump`);
- the Blockchain SQLite database (`trade.db`) captured with the SQLite Online Backup API while the frontend container is running;
- the separate Python Intelligence SQLite database (`intelligence.sqlite`) captured with Python's SQLite Online Backup API from the `potapoff-intelligence` worker;
- `.env.server`;
- `backend.env`;
- production Compose file;
- previous `.current-image-tag` when present;
- Control Center `.env`, `.env.intelligence`, `sources.json` and `logs.json` when present;
- `SHA256SUMS` covering the complete recovery set.

The script immediately runs `sha256sum -c SHA256SUMS`. The backup directory is mode `0700` and backups older than 14 days are pruned.

The frontend container owns the `/app/data/trade.db` mount. The backup uses `better-sqlite3` Online Backup API inside that container, checks the source with `quick_check`, checks the snapshot with `integrity_check`, copies the completed snapshot into the same incomplete recovery directory, and includes it in `SHA256SUMS`. A plain filesystem copy of a live `trade.db` is forbidden because committed pages may still be in the WAL file. If the frontend container or database is missing, the whole backup fails closed and the incomplete directory is removed.

The Python Intelligence worker owns a separate `intelligence-state` volume mounted at `/var/lib/potapoff-intelligence`. The backup runs Python's SQLite Online Backup API inside the `potapoff-intelligence` container, checks the snapshot integrity and application-table presence, and includes the standalone result as `intelligence.sqlite` in the same manifest. Its temporary file is unique per backup and removed on success or failure. A missing worker or source database fails the whole backup closed. This is a separate store from the Node cross-source Intelligence PostgreSQL target configured by `INTELLIGENCE_DATABASE_URL`; that Node target still has no verified production backup schedule in this repository.

`verify-backup-restore.sh` verifies the complete checksum manifest, restores both PostgreSQL dumps into a network-isolated disposable Docker container, and independently copies and integrity-checks both SQLite snapshots in fresh temporary paths. This proves archive readability and synthetic restore behavior in CI; it does not prove a live host backup, off-host copy, or a measured RPO/RTO.

If either PostgreSQL dump or either SQLite snapshot cannot be created and verified, deployment stops before migration.

## 6. Schema transition and service switch

After backup succeeds, the deployment is considered started and full rollback becomes available.

Order:

1. record previous/new image tags;
2. stop Telegram bot, Twitter discovery daemon and Celery writer;
3. run `alembic upgrade heads` using a one-shot container from the new backend image;
4. start core services on the new tag;
5. build/start the staged Control Center source;
6. restart nginx;
7. synchronize Telegram bot / Telegram Intelligence optional services;
8. prove Control Center -> backend Twitter admin authentication;
9. start Celery;
10. start the required Twitter discovery daemon;
11. run the full production healthcheck while rollback is still armed;
12. verify the admin virtual host;
13. only then delete the previous Control Center source and disarm rollback.

Production backend startup explicitly runs Uvicorn and does not implicitly run Alembic. This is required so an older backend image can start during rollback even when the database contains newer additive migration revisions.

## 7. Required production health evidence

A successful forward deployment must produce evidence equivalent to:

- `ADMIN_READY_OK`
- `TWITTER_ADMIN_BACKEND_OK`
- `TWITTER_SETTINGS_WRITE_SMOKE_OK`
- `HEALTHCHECK_OK ... twitter_discovery=running twitter_settings=write_conflict_ok frontend_build=verified`
- `ADMIN_ROUTE_OK ...`
- `DEPLOYMENT_OK tag=<sha>`

The healthcheck verifies:

- required containers are running/healthy;
- frontend root, Mini App, Trade Analysis, Social Analysis and FastAPI health endpoints;
- Mini App configuration;
- frontend served build SHA equals the release SHA;
- admin virtual host routing;
- optional Telegram webhook/runtime when configured;
- Twitter discovery daemon presence;
- Twitter settings control plane using the dedicated secret.

### Twitter settings write/conflict smoke

The smoke uses the protected backend API:

1. GET canonical crawler settings and version;
2. PUT the same semantic settings using that version;
3. verify returned values are unchanged;
4. repeat the consumed version token and require HTTP `409`.

One real concurrent admin save between the GET and first PUT is tolerated by one reread/retry. A broken write path or broken optimistic conflict semantics fails the healthcheck and therefore the deployment.

## 8. Automatic rollback behavior

Any error while the deploy trap is armed triggers rollback.

### Preflight failure before backup

- restore previous Control Center source if it had been activated;
- remove staged source;
- leave core containers unchanged;
- report `PREFLIGHT_ROLLBACK_OK`.

### Failure after backup/schema transition

- restore previous Control Center source;
- restore previous image tag;
- stop new writers;
- start previous backend/frontend/core services;
- rebuild/start restored Control Center source;
- restart previous Celery;
- attempt previous Twitter discovery daemon and tolerate its absence if the previous image predates that command;
- restore Telegram optional services;
- run rollback healthcheck;
- verify admin route;
- report `ROLLBACK_OK tag=<previous-tag>`.

Because the Twitter migrations are additive, the previous application release can run against the upgraded database. Do not introduce destructive/renaming migrations into this release without redesigning the rollback strategy.

## 9. Manual database recovery

If automatic rollback itself cannot restore service, stop application writers before restoring a dump.

Verify backup integrity first:

```bash
cd /opt/potapoff-deploy/backups/<timestamp>
sha256sum -c SHA256SUMS
```

Product and Control Center dumps are PostgreSQL custom format and must be restored with `pg_restore` into the correct databases. The `trade.db` snapshot is the Blockchain SQLite store; stop the frontend and every other writer to the `/app/data` mount before replacing it. The `intelligence.sqlite` snapshot is the separate Python Intelligence worker store; stop both `potapoff-intelligence` and the Admin reader before replacing the file in the `intelligence-state` volume at `/var/lib/potapoff-intelligence/intelligence.sqlite3`. For either SQLite store, verify the manifest first, preserve the previous database and any WAL/SHM sidecars in quarantine, install the standalone snapshot with the correct container ownership and restrictive permissions, and run `PRAGMA integrity_check` on the restored copy before restarting writers. Never overwrite an open SQLite database or copy a live SQLite database without its Online Backup API. The Node cross-source Intelligence PostgreSQL target is not covered by this bundle and needs its own separately approved backup and restore plan.

Database restore is a destructive emergency action; do not perform it merely because an application image rollback was needed.

## 10. Merge/deploy stop conditions

Stop and do not merge/deploy when any of the following is true:

- Actions jobs have no executed steps/logs;
- predeploy or Security Gates are red for an actual code/test step;
- Alembic does not report a single merged head at `0021_twitter_run_singleton` or later reviewed head;
- exact-SHA release images are absent;
- product or admin PostgreSQL backup fails, `trade.db` is missing, or the SQLite integrity check fails;
- `TWITTER_CRAWLER_ADMIN_KEY` is present in `.env.server` or differs between backend/admin server-only files;
- Control Center cannot reach the protected crawler settings endpoint;
- Twitter daemon does not stay running;
- settings no-op write / stale-409 smoke fails;
- served frontend build SHA differs from the deployed image tag;
- `main` moved after the reviewed integration base and the branch has not been reconciled again.
