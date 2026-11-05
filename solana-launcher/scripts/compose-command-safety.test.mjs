import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const backendDockerfile = await readFile(resolve(root, "backend/Dockerfile"), "utf8");
const subscriptionCompose = await readFile(resolve(root, "../solana-subscription-service/docker-compose.prod.yml"), "utf8");
const subscriptionReadonlySql = await readFile(resolve(root, "../solana-subscription-service/scripts/provision-readonly-role.sql"), "utf8");
const memecoinCompose = await readFile(resolve(root, "../memecoin-intelligence/docker-compose.production.yml"), "utf8");
const memecoinReadonlySql = await readFile(resolve(root, "../memecoin-intelligence/scripts/provision-readonly-role.sql"), "utf8");
const fullBacktestWorkflow = await readFile(resolve(root, "../.github/workflows/full-backtest-audit.yml"), "utf8");
const telegramWorkflow = await readFile(resolve(root, "../.github/workflows/telegram-intelligence-v19-ci.yml"), "utf8");
const predeployWorkflow = await readFile(resolve(root, "../.github/workflows/potapoff-predeploy-gate.yml"), "utf8");

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

test("Backend production image removes vulnerable Python packaging tools", () => {
  assert.match(backendDockerfile, /pip uninstall -y setuptools wheel jaraco\.context/);
  assert.match(backendDockerfile, /importlib\.metadata/);
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
