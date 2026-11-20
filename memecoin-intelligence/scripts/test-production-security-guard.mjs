import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = "import { assertProductionApiSecurity } from './src/server/config/env.ts'; assertProductionApiSecurity();";
const baseEnv = {
  ...process.env,
  NODE_ENV: "production",
  SECURITY_HEADERS_STRICT: "true",
  SECURITY_RBAC_ENABLED: "true",
  INTERNAL_ADMIN_API_KEY: "ci-only-not-a-secret"
};

function run(overrides = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", entry], {
    cwd: root,
    env: { ...baseEnv, ...overrides },
    encoding: "utf8",
    timeout: 10_000
  });
}

const valid = run();
assert.equal(valid.status, 0, valid.stderr || valid.stdout);

const missingHeaders = run({ SECURITY_HEADERS_STRICT: "false" });
assert.notEqual(missingHeaders.status, 0);
assert.match(missingHeaders.stderr, /SECURITY_HEADERS_STRICT must be enabled/);

const missingRbac = run({ SECURITY_RBAC_ENABLED: "false" });
assert.notEqual(missingRbac.status, 0);
assert.match(missingRbac.stderr, /SECURITY_RBAC_ENABLED must be enabled/);

const missingApiKey = run({ INTERNAL_ADMIN_API_KEY: "", INTERNAL_API_KEY: "" });
assert.notEqual(missingApiKey.status, 0);
assert.match(missingApiKey.stderr, /INTERNAL_ADMIN_API_KEY or INTERNAL_API_KEY is required/);

console.log("Production API security guard rejects unsafe API configuration without blocking migration/worker config imports.");
