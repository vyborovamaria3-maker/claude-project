import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const adminRoot = resolve(root, "../admin-site");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const destructive = await readFile(resolve(root, "scripts/compose-down-volumes.mjs"), "utf8");
const runtimeHelper = resolve(adminRoot, "deploy/refresh-runtime-env.sh");
const mainDeploy = await readFile(resolve(root, "scripts/deploy-production.sh"), "utf8");
const localDeploy = await readFile(resolve(root, "scripts/deploy-production-local.sh"), "utf8");
const adminDeploy = await readFile(resolve(adminRoot, "deploy/production-deploy.sh"), "utf8");
const adminRollback = await readFile(resolve(adminRoot, "deploy/production-rollback.sh"), "utf8");
const productionWorkflow = await readFile(resolve(root, "../.github/workflows/potapoff-production.yml"), "utf8");

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
      "SUBSCRIPTION_ADMIN_KEY=subscription-secret",
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
    assert.doesNotMatch(runtime, /ADMIN_STATE_DB_PASSWORD|ADMIN_STATE_APP_PASSWORD|ADMIN_STATE_POSTGRES_DSN|ADMIN_STATE_RUNTIME_USER|POTAPOFF_SUBSCRIPTION_ADMIN_KEY|SUBSCRIPTION_ADMIN_KEY|EXTRA_UNLISTED_SECRET/);
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
});

test("deployment staging archives only tracked admin source", () => {
  assert.match(localDeploy, /git -C "\$SOURCE_ROOT" archive --format=tar "\$DEPLOY_SHA" admin-site/);
  assert.match(productionWorkflow, /git archive --format=tar "\$RELEASE_SHA" admin-site/);
  assert.doesNotMatch(localDeploy, /--exclude='admin-site\/\.env/);
  assert.doesNotMatch(productionWorkflow, /--exclude='admin-site\/\.env/);
});
