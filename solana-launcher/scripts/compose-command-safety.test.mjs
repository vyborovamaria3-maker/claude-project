import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const adminRoot = resolve(root, "../admin-site");
const adminSources = JSON.parse(await readFile(resolve(adminRoot, "sources.json"), "utf8"));
const adminSourcesExample = JSON.parse(await readFile(resolve(adminRoot, "sources.example.json"), "utf8"));
const adminRuntimeExample = await readFile(resolve(adminRoot, ".env.runtime.example"), "utf8");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const destructive = await readFile(resolve(root, "scripts/compose-down-volumes.mjs"), "utf8");
const runtimeHelper = resolve(adminRoot, "deploy/refresh-runtime-env.sh");
const mainDeploy = await readFile(resolve(root, "scripts/deploy-production.sh"), "utf8");
const localDeploy = await readFile(resolve(root, "scripts/deploy-production-local.sh"), "utf8");
const adminDeploy = await readFile(resolve(adminRoot, "deploy/production-deploy.sh"), "utf8");
const adminRollback = await readFile(resolve(adminRoot, "deploy/production-rollback.sh"), "utf8");
const productionWorkflow = await readFile(resolve(root, "../.github/workflows/potapoff-production.yml"), "utf8");
const productionCompose = await readFile(resolve(root, "docker-compose.production.yml"), "utf8");
const backupScript = await readFile(resolve(root, "scripts/backup-production.sh"), "utf8");
const dockerignore = await readFile(resolve(root, ".dockerignore"), "utf8");
const telegramDockerfile = await readFile(resolve(root, "Dockerfile.telegram-bot"), "utf8");
const subscriptionApiDockerfile = await readFile(resolve(root, "../solana-subscription-service/apps/api/Dockerfile"), "utf8");
const subscriptionWebDockerfile = await readFile(resolve(root, "../solana-subscription-service/apps/web/Dockerfile"), "utf8");
const subscriptionDockerignore = await readFile(resolve(root, "../solana-subscription-service/.dockerignore"), "utf8");
const backendDockerfile = await readFile(resolve(root, "backend/Dockerfile"), "utf8");
const subscriptionCompose = await readFile(resolve(root, "../solana-subscription-service/docker-compose.prod.yml"), "utf8");
const subscriptionReadonlySql = await readFile(resolve(root, "../solana-subscription-service/scripts/provision-readonly-role.sql"), "utf8");
const subscriptionRoleEntrypointPath = resolve(root, "../solana-subscription-service/scripts/run-readonly-role-provisioner.sh");
const subscriptionRoleEntrypoint = await readFile(subscriptionRoleEntrypointPath, "utf8");
const memecoinCompose = await readFile(resolve(root, "../memecoin-intelligence/docker-compose.production.yml"), "utf8");
const memecoinDockerfile = await readFile(resolve(root, "../memecoin-intelligence/Dockerfile.production"), "utf8");
const memecoinDockerignore = await readFile(resolve(root, "../memecoin-intelligence/.dockerignore"), "utf8");
const sourceRoleRehearsal = await readFile(resolve(root, "../.github/scripts/test-readonly-source-roles.sh"), "utf8");
const memecoinReadonlySql = await readFile(resolve(root, "../memecoin-intelligence/scripts/provision-readonly-role.sql"), "utf8");
const memecoinRoleEntrypoint = await readFile(resolve(root, "../memecoin-intelligence/scripts/run-readonly-role-provisioner.sh"), "utf8");
const fullBacktestWorkflow = await readFile(resolve(root, "../.github/workflows/full-backtest-audit.yml"), "utf8");
const telegramWorkflow = await readFile(resolve(root, "../.github/workflows/telegram-intelligence-v19-ci.yml"), "utf8");
const predeployWorkflow = await readFile(resolve(root, "../.github/workflows/potapoff-predeploy-gate.yml"), "utf8");

function serviceSection(compose, name) {
  const marker = "\\n  " + name + ":\\n";
  const start = compose.indexOf(marker);
  assert.notEqual(start, -1, "missing Compose service " + name);
  const body = compose.slice(start + marker.length);
  const nextService = body.search(/\\n  [a-zA-Z0-9_-]+:\\n/);
  return nextService < 0 ? body : body.slice(0, nextService);
}

test("ordinary Compose down never removes named volumes", () => {
  assert.equal(pkg.scripts["compose:down"], "docker compose down");
  assert.doesNotMatch(pkg.scripts["compose:down"], /(^|\s)(-v|--volumes)(\s|$)/);
});

test("volume deletion is separate and requires explicit confirmation", () => {
  assert.equal(pkg.scripts["compose:down:volumes"], "node scripts/compose-down-volumes.mjs");
  assert.match(destructive, /CONFIRM_DOCKER_VOLUME_DELETION/);
  assert.match(destructive, /I_UNDERSTAND/);
  assert.match(destructive, /\["compose", "down", "--volumes"\]/);
});

test("admin runtime env is generated from the explicit allowlist and mode 0600", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "potapoff-runtime-env-"));
  try {
    await writeFile(join(fixture, ".env.runtime.example"), [
      "# allowlist",
      "ADMIN_USERNAME=admin",
      "ADMIN_SESSION_SECRET=",
      "ADMIN_INTELLIGENCE_POSTGRES_DSN=",
      "TWITTER_CRAWLER_ADMIN_KEY=",
      ""
    ].join("\n"));
    await writeFile(join(fixture, ".env"), [
      "ADMIN_USERNAME=operator",
      "ADMIN_SESSION_SECRET=session-secret",
      "ADMIN_INTELLIGENCE_POSTGRES_DSN=postgresql://readonly",
      "TWITTER_CRAWLER_ADMIN_KEY=dedicated-admin-key",
      "ADMIN_STATE_DB_PASSWORD=bootstrap-secret",
      "ADMIN_STATE_APP_PASSWORD=app-secret",
      "ADMIN_STATE_BOOTSTRAP_DSN=postgresql://bootstrap",
      "ADMIN_STATE_MIGRATOR_DSN=postgresql://migrator",
      "ADMIN_STATE_RUNTIME_DSN=postgresql://runtime",
      "POSTGRES_PASSWORD=postgres-secret",
      "REDIS_PASSWORD=redis-secret",
      "SUBSCRIPTION_ADMIN_KEY=subscription-secret",
      "ADMIN_INTELLIGENCE_DB=admin_intelligence",
      "EXTRA_UNLISTED_SECRET=must-not-pass",
      ""
    ].join("\n"));

    execFileSync("bash", [runtimeHelper], {
      env: { ...process.env, ADMIN_DIR: fixture }
    });
    const runtime = await readFile(join(fixture, ".env.runtime"), "utf8");
    assert.match(runtime, /ADMIN_USERNAME=operator/);
    assert.match(runtime, /ADMIN_INTELLIGENCE_POSTGRES_DSN=postgresql:\/\/readonly/);
    assert.match(runtime, /TWITTER_CRAWLER_ADMIN_KEY=dedicated-admin-key/);
    assert.doesNotMatch(runtime, /ADMIN_STATE_DB_PASSWORD|ADMIN_STATE_APP_PASSWORD|ADMIN_STATE_POSTGRES_DSN|ADMIN_STATE_BOOTSTRAP_DSN|ADMIN_STATE_MIGRATOR_DSN|ADMIN_STATE_RUNTIME_DSN|ADMIN_STATE_RUNTIME_USER|POSTGRES_PASSWORD|REDIS_PASSWORD|POTAPOFF_SUBSCRIPTION_ADMIN_KEY|SUBSCRIPTION_ADMIN_KEY|ADMIN_INTELLIGENCE_DB|EXTRA_UNLISTED_SECRET/);
    assert.equal((await stat(join(fixture, ".env.runtime"))).mode & 0o777, 0o600);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("forward deploy and rollback regenerate the runtime environment safely", () => {
  const forward = mainDeploy.slice(mainDeploy.lastIndexOf("\nactivate_admin_source\n"));
  assert.match(forward, /activate_admin_source\s+ensure_twitter_crawler_admin_secret\s+refresh_admin_runtime_env/);
  assert.match(mainDeploy, /refresh_admin_runtime_env\(\)[\s\S]*refresh-runtime-env\.sh/);
  assert.match(mainDeploy, /RUNTIME_ENV_TEMPLATE="\$ADMIN_STAGE_DIR\/admin-site\/\.env\.runtime\.example"/);
  assert.match(adminDeploy, /bash "\$SCRIPT_DIR\/refresh-runtime-env\.sh"/);
  assert.match(adminRollback, /refresh-runtime-env\.sh/);
  assert.ok(localDeploy.includes("POSTGRES_") && localDeploy.includes("REDIS_PASSWORD"));
  assert.ok(localDeploy.indexOf("awk -F= ") < localDeploy.indexOf("config --quiet"));
  assert.ok(localDeploy.indexOf('bash "$ADMIN_DIR/deploy/refresh-runtime-env.sh"') < localDeploy.indexOf('docker compose --project-directory "$ADMIN_DIR" -f "$ADMIN_COMPOSE_FILE" config --quiet'));
});

test("deployment staging archives only tracked admin source", () => {
  assert.match(localDeploy, /git -C "\$SOURCE_ROOT" archive --format=tar "\$DEPLOY_SHA" admin-site/);
  assert.match(productionWorkflow, /git archive --format=tar "\$RELEASE_SHA" admin-site/);
  assert.doesNotMatch(localDeploy, /--exclude='admin-site\/\.env/);
  assert.doesNotMatch(productionWorkflow, /--exclude='admin-site\/\.env/);
});

test("Subscription API production image prunes development packages and the npm CLI", () => {
  assert.match(subscriptionApiDockerfile, /npm prune --omit=dev/);
  assert.match(subscriptionApiDockerfile, /rm -rf \/usr\/local\/lib\/node_modules\/npm \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx/);
  assert.match(subscriptionApiDockerfile, /COPY --from=build \/app\/node_modules\/\.prisma \.\/node_modules\/\.prisma/);
});

test("Backend production image isolates build tools from the runtime stage", () => {
  const runtimeStage = backendDockerfile.split(/^FROM python:3\.12-slim AS runtime$/m)[1];
  assert.ok(runtimeStage, "backend Dockerfile must define a dedicated runtime stage");
  assert.match(backendDockerfile, /^FROM python:3\.12-slim AS builder$/m);
  assert.match(backendDockerfile, /^FROM python:3\.12-slim AS runtime$/m);
  assert.match(runtimeStage, /COPY --from=builder \/install\/ \/usr\/local\//);
  assert.match(runtimeStage, /pip uninstall -y setuptools wheel/);
  assert.match(runtimeStage, /importlib\.metadata/);
  assert.match(runtimeStage, /blocked=\{"setuptools","wheel","jaraco\.context"\}/);
  assert.doesNotMatch(runtimeStage, /apt-get install[^\n]*build-essential|pip wheel|pip install -e \.|COPY pyproject\.toml/);
});

test("Admin product data sources use dedicated read-only roles and shared Docker aliases", () => {
  const allowed = new Set(adminRuntimeExample.split(/\r?\n/)
    .map((line) => line.match(/^([A-Z_][A-Z0-9_]*)=/)?.[1])
    .filter(Boolean));
  const expected = {
    potapoff: ["potapoff_readonly", "POTAPOFF_DB_READONLY_PASSWORD", "postgres"],
    subscription: ["solsub_readonly", "SUBSCRIPTION_DB_READONLY_PASSWORD", "subscription-postgres"],
    memecoin: ["memecoin_readonly", "MEMECOIN_DB_READONLY_PASSWORD", "memecoin-postgres"]
  };
  for (const source of [...adminSources, ...adminSourcesExample]) {
    const spec = expected[source.id];
    if (!spec) continue;
    const match = source.dsn.match(/^postgresql:\/\/([^:]+):\$\{([A-Z_][A-Z0-9_]*)\}@([^:]+):/);
    assert.ok(match, "source " + source.id + " must use a password placeholder");
    assert.equal(match[1], spec[0], source.id + " must not use the application login");
    assert.equal(match[2], spec[1], source.id + " must use its dedicated read-only secret");
    assert.equal(match[3], spec[2], source.id + " must resolve on the shared data network");
    assert.ok(allowed.has(match[2]), "runtime allowlist must include " + match[2]);
  }
  assert.match(subscriptionCompose, /aliases:\s*\n\s*- subscription-postgres/);
  assert.match(memecoinCompose, /aliases:\s*\n\s*- memecoin-postgres/);
  assert.match(subscriptionCompose, /name: potapoff_default/);
  assert.match(memecoinCompose, /name: potapoff_default/);
  for (const sql of [subscriptionReadonlySql, memecoinReadonlySql]) {
    assert.match(sql, /NOINHERIT/);
    assert.match(sql, /NOBYPASSRLS/);
    assert.match(sql, /GRANT SELECT ON ALL TABLES IN SCHEMA public/);
    assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE/);
    assert.match(sql, /default_transaction_read_only = on/);
    assert.doesNotMatch(sql, /GRANT ALL PRIVILEGES/);
  }
});

test("Memecoin production runtime uses app credentials and a separate migration image", () => {
  const api = serviceSection(memecoinCompose, "api");
  const worker = serviceSection(memecoinCompose, "worker");
  const migrator = serviceSection(memecoinCompose, "migrator");
  for (const runtime of [api, worker]) {
    assert.match(runtime, /DATABASE_URL: postgresql:\/\/\$\{POSTGRES_APP_USER/);
    assert.doesNotMatch(runtime, /POSTGRES_PASSWORD|POSTGRES_MIGRATOR_PASSWORD/);
  }
  assert.match(migrator, /profiles: \["migrate"\]/);
  assert.match(migrator, /target: migrator/);
  assert.match(migrator, /POSTGRES_MIGRATOR_USER/);
  assert.match(memecoinDockerfile, /FROM build AS migrator/);
  assert.match(memecoinDockerfile, /FROM build AS runtime-deps/);
  assert.match(memecoinDockerignore, /^\.env$/m);
  assert.match(memecoinDockerignore, /^\.env\.\*$/m);
  assert.match(memecoinDockerignore, /^!\.env\.example$/m);
});

test("SolSub API, bot and web receive only their required runtime credentials", () => {
  const api = serviceSection(subscriptionCompose, "api");
  const web = serviceSection(subscriptionCompose, "web");
  const bot = serviceSection(subscriptionCompose, "bot");
  const migrator = serviceSection(subscriptionCompose, "migrator");
  assert.match(api, /DATABASE_URL: postgresql:\/\/\$\{POSTGRES_APP_USER/);
  assert.doesNotMatch(api, /env_file:|POSTGRES_PASSWORD|POSTGRES_MIGRATOR_PASSWORD/);
  assert.match(bot, /DATABASE_URL: postgresql:\/\/\$\{POSTGRES_APP_USER/);
  assert.doesNotMatch(bot, /env_file:|POSTGRES_PASSWORD|POSTGRES_MIGRATOR_PASSWORD|JWT_ACCESS_SECRET/);
  assert.doesNotMatch(web, /env_file:|DATABASE_URL|TELEGRAM_BOT_TOKEN|JWT_ACCESS_SECRET|POSTGRES_/);
  assert.match(migrator, /profiles: \["migrate"\]/);
  assert.match(migrator, /target: migrator/);
  assert.match(migrator, /POSTGRES_MIGRATOR_USER/);
  assert.match(subscriptionApiDockerfile, /FROM build AS migrator/);
  const apiRunner = subscriptionApiDockerfile.split(/^FROM node:22-alpine AS runner$/m)[1];
  assert.ok(apiRunner);
  assert.match(apiRunner, /CMD \["node", "apps\/api\/dist\/apps\/api\/src\/server\.js"\]/);
  assert.doesNotMatch(apiRunner, /npm run/);
  assert.match(subscriptionWebDockerfile, /ARG NEXT_PUBLIC_API_URL/);
  assert.match(subscriptionDockerignore, /^\.env$/m);
  assert.match(subscriptionDockerignore, /^\.env\.\*$/m);
  assert.match(subscriptionDockerignore, /^!\.env\.example$/m);
});

test("Subscription and Memecoin provisioners guard every restricted identity inside the container", () => {
  assert.equal(subscriptionRoleEntrypoint, memecoinRoleEntrypoint);
  for (const role of ["POSTGRES_APP_USER", "POSTGRES_MIGRATOR_USER", "POSTGRES_READONLY_USER"]) {
    assert.ok(subscriptionRoleEntrypoint.includes(role));
  }
  assert.match(subscriptionRoleEntrypoint, /"\$PGUSER" = "\$POSTGRES_APP_USER"/);
  assert.match(subscriptionRoleEntrypoint, /"\$PGUSER" = "\$POSTGRES_MIGRATOR_USER"/);
  assert.match(subscriptionRoleEntrypoint, /"\$PGUSER" = "\$POSTGRES_READONLY_USER"/);
  assert.match(subscriptionRoleEntrypoint, /exec psql -X -v ON_ERROR_STOP=1 -f \/provision\/readonly-role\.sql/);
  for (const compose of [subscriptionCompose, memecoinCompose]) {
    const provisioner = serviceSection(compose, "postgres-readonly-provisioner");
    assert.match(provisioner, /run-readonly-role-provisioner\.sh:\/provision\/run-readonly-role-provisioner\.sh:ro/);
    assert.match(provisioner, /entrypoint: \["\/bin\/sh", "\/provision\/run-readonly-role-provisioner\.sh"\]/);
    assert.doesNotMatch(provisioner, /command:/);
  }
  assert.match(sourceRoleRehearsal, /test_role_set "solsub_role_ci"/);
  assert.match(sourceRoleRehearsal, /test_role_set "memecoin_role_ci"/);
});

test("read-only role provisioner refuses a restricted bootstrap identity", () => {
  const result = spawnSync("sh", [subscriptionRoleEntrypointPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PGHOST: "127.0.0.1",
      PGDATABASE: "fixture",
      PGUSER: "solsub_readonly",
      PGPASSWORD: "fixture-only",
      POSTGRES_APP_USER: "solsub_app",
      POSTGRES_APP_PASSWORD: "fixture-only",
      POSTGRES_MIGRATOR_USER: "solsub_migrator",
      POSTGRES_MIGRATOR_PASSWORD: "fixture-only",
      POSTGRES_READONLY_USER: "solsub_readonly",
      POSTGRES_READONLY_PASSWORD: "fixture-only"
    }
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /Refusing to provision roles while connected as a restricted role/);
});

test("Telegram bot Docker context excludes deployment environment secrets", () => {
  assert.match(telegramDockerfile, /COPY --chown=node:node \. \./);
  assert.match(dockerignore, /^backend\.env\*/m);
  assert.match(dockerignore, /^\*\.env$/m);
  assert.match(dockerignore, /^\*\.env\.\*/m);
});

test("production deploy stages every PostgreSQL provisioner and backup verifier dependency", () => {
  assert.match(productionCompose, /\.\/scripts\/provision-postgres-roles\.sql:\/provision\/roles\.sql:ro/);
  assert.match(productionWorkflow, /solana-launcher\/scripts\/provision-postgres-roles\.sql/);
  assert.match(localDeploy, /install -m 0644 "\$SOURCE_ROOT\/solana-launcher\/scripts\/provision-postgres-roles\.sql"/);
  assert.match(localDeploy, /"\$SOURCE_ROOT\/solana-launcher\/scripts\/verify-backup-restore\.sh"/);
  assert.match(backupScript, /verify-backup-restore\.sh/);
});

test("production Compose CI fixtures always create the runtime env file", () => {
  assert.match(fullBacktestWorkflow, /: > \.env\.runtime/);
  assert.match(telegramWorkflow, /: > \.env\.runtime/);
  assert.match(predeployWorkflow, /: > solana-launcher\/\.env\.runtime/);
});
