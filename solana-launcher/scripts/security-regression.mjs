import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const landing = read("components/PublicLandingPage.tsx");
assert(landing.includes('const AUTH_ENDPOINT = "/api/v1/auth/login-password"'), "landing auth must be same-origin");
assert(!landing.includes("queryApi"), "landing must not accept query-controlled auth destination");
assert(!landing.includes('searchParams.get("api")'), "landing must not read api query parameter for credentials");

const routeAuth = read("lib/routeAuth.ts");
assert(routeAuth.includes("/api/v1/users/access"), "paid Next routes must use subscriber access probe");
assert(routeAuth.includes("potapoff_access_token"), "paid Next routes must support the HttpOnly session cookie");

const loginProxy = read("app/api/v1/auth/login-password/route.ts");
assert(loginProxy.includes("httpOnly: true"), "paid login must issue an HttpOnly server-session cookie");
assert(loginProxy.includes('sameSite: "strict"'), "paid login cookie must use strict SameSite policy");

const logoutProxy = read("app/api/v1/auth/logout/route.ts");
assert(logoutProxy.includes("maxAge: 0"), "logout must expire the HttpOnly paid-session cookie");

const apify = read("app/api/integrations/apify/pumpfun-sync/route.ts");
assert(apify.includes("requireProdAuth"), "Apify pumpfun-sync must require paid auth");
assert(apify.includes("maxItemsRaw > 500"), "Apify maxItems must be bounded");

const migration = read("app/api/migrations/xlsx/route.ts");
assert(migration.includes("requireProdAuth"), "migration dataset must require paid auth");
assert(migration.includes("omitFilePath"), "migration responses must omit stored file paths");

const tokenInfo = read("app/api/trade/token-info/route.ts");
assert(tokenInfo.includes('redirect: "manual"'), "metadata fetch must not follow redirects");
assert(tokenInfo.includes("ALLOWED_METADATA_HOSTS"), "metadata fetch must use a host allowlist");
assert(tokenInfo.includes("MAX_METADATA_BYTES"), "metadata response size must be bounded");

const proxy = read("proxy.ts");
assert(proxy.includes('"/api/trade/dev-twitter"'), "expensive X route must be behind the paid gateway");
assert(proxy.includes("strict-dynamic"), "production CSP must be nonce-aware");
assert(proxy.includes('"https://gmgn.ai"'), "CSP must preserve the live browser GMGN fallback");

const telegramApi = read("backend/app/api/v1/telegram_intelligence.py");
assert(telegramApi.includes("get_current_subscriber"), "Telegram/social intelligence reads must require a subscriber");

const dockerignore = read(".dockerignore");
assert(dockerignore.includes(".env.*"), "Docker build context must exclude env files");

const nginx = read("nginx/nginx.conf");
assert(nginx.includes("location = /metrics"), "metrics location must be explicit");
assert(nginx.includes("deny all;"), "metrics must not be public");
assert(!nginx.includes("$proxy_add_x_forwarded_for"), "ingress must not preserve an untrusted forwarded chain");

const backendDocker = read("backend/Dockerfile");
const frontendDocker = read("Dockerfile.frontend.prod");
assert(backendDocker.includes("USER potapoff"), "backend runtime must be non-root");
assert(frontendDocker.includes("USER potapoff"), "frontend runtime must be non-root");

const migrationBootstrap = read("scripts/import-migration-xlsx.cjs");
assert(
  migrationBootstrap.includes("if (request === 'xlsx') return safeXlsx"),
  "migration importer must never load the legacy SheetJS implementation",
);
assert(
  migrationBootstrap.includes("./xlsx-safe-package/index.cjs"),
  "migration importer must route xlsx reads to the bounded local reader",
);
execFileSync(process.execPath, [path.join(root, "scripts/xlsx-safe-package/test.mjs")], { stdio: "inherit" });

const workflowDir = path.resolve(root, "../.github/workflows");
for (const entry of fs.readdirSync(workflowDir, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
  const workflow = fs.readFileSync(path.join(workflowDir, entry.name), "utf8");
  assert(!workflow.includes("pull_request_target:"), `${entry.name}: pull_request_target is not allowed`);
  assert(!workflow.includes("ssh-keyscan"), `${entry.name}: dynamic SSH host trust is not allowed`);

  for (const line of workflow.split(/\r?\n/)) {
    const match = line.match(/^\s*uses:\s*([^\s#]+)\s*(?:#.*)?$/);
    if (!match) continue;
    const reference = match[1];
    if (reference.startsWith("./")) continue;
    const at = reference.lastIndexOf("@");
    assert(at > 0, `${entry.name}: external action must have an immutable ref: ${reference}`);
    const ref = reference.slice(at + 1);
    assert(/^[0-9a-f]{40}$/i.test(ref), `${entry.name}: external action must be pinned to a 40-char SHA: ${reference}`);
  }
}

console.log("SECURITY_REGRESSION_OK");
