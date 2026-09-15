import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function walkFiles(directory, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", ".next", ".git"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(absolute, result);
    else result.push(absolute);
  }
  return result;
}

function serviceBlock(compose, service, nextService) {
  const start = `\n  ${service}:\n`;
  const end = `\n  ${nextService}:\n`;
  assert(compose.includes(start), `compose service missing: ${service}`);
  assert(compose.includes(end), `compose service missing: ${nextService}`);
  return compose.split(start, 2)[1].split(end, 1)[0];
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
assert(migration.includes('process.env.NODE_ENV === "production"'), "migration dataset must be disabled in production");
assert(migration.includes('status: 404'), "production migration dataset must return not found");
assert(migration.includes("omitFilePath"), "local migration diagnostics must omit stored file paths");

const tokenInfo = read("app/api/trade/token-info/route.ts");
assert(tokenInfo.includes('redirect: "manual"'), "metadata fetch must not follow redirects");
assert(tokenInfo.includes("ALLOWED_METADATA_HOSTS"), "metadata fetch must use a host allowlist");
assert(tokenInfo.includes("MAX_METADATA_BYTES"), "metadata response size must be bounded");

const proxy = read("proxy.ts");
assert(proxy.includes('"/api/trade"'), "all trade routes must be behind the paid gateway");
assert(proxy.includes('"/api/database"'), "database diagnostics must be private in production");
assert(proxy.includes("HEAVY_ROUTE_PREFIXES"), "expensive API routes must be rate limited");
assert(proxy.includes("strict-dynamic"), "production CSP must be nonce-aware");
assert(proxy.includes('"https://gmgn.ai"'), "CSP must preserve the live browser GMGN fallback");

const subscriptionStore = read("lib/telegram/subscription-store.ts");
assert(
  subscriptionStore.includes("process.env.SUBSCRIPTION_INTERNAL_KEY"),
  "Mini App subscription calls must use the checkout-only key",
);
assert(
  !subscriptionStore.includes("process.env.BACKEND_API_KEY"),
  "Mini App must never receive the intelligence master key",
);
assert(
  !subscriptionStore.includes("SUBSCRIPTION_ADMIN_KEY"),
  "Mini App must never receive the subscription admin key",
);

const productionCompose = read("docker-compose.production.yml");
const backendService = serviceBlock(productionCompose, "backend", "celery-worker");
const frontendService = serviceBlock(productionCompose, "frontend", "telegram-bot");
assert(backendService.includes("SUBSCRIPTION_ADMIN_KEY"), "backend API must receive the subscription admin key");
assert(
  backendService.includes('REQUIRE_SUBSCRIPTION_ADMIN_KEY: "true"'),
  "backend API must fail closed when the subscription admin key is missing",
);
assert(frontendService.includes("SUBSCRIPTION_INTERNAL_KEY"), "frontend must receive the checkout-only key");
assert(!frontendService.includes("SUBSCRIPTION_ADMIN_KEY"), "frontend must not receive the subscription admin key");
assert(!frontendService.includes("BACKEND_API_KEY"), "frontend must not receive the backend master key");

const devForensics = read("app/api/trade/dev-forensics/route.ts");
assert(
  !devForensics.includes("solana-mainnet.g.alchemy.com"),
  "dev-forensics must not contain a hardcoded provider credential URL",
);
assert(devForensics.includes("forwardedAuthHeaders"), "authenticated internal trade calls must forward auth");

const telegramTasks = read("telegram-bot/handlers/tasks.ts");
assert(
  telegramTasks.includes("task.telegram_user_id !== userId"),
  "Telegram task cancellation must enforce task ownership",
);

const telegramApi = read("backend/app/api/v1/telegram_intelligence.py");
assert(telegramApi.includes("get_current_subscriber"), "Telegram/social intelligence reads must require a subscriber");

const dockerignore = read(".dockerignore");
assert(dockerignore.includes(".env.*"), "Docker build context must exclude env files");

const nginx = read("nginx/nginx.conf");
assert(nginx.includes("location = /metrics"), "metrics location must be explicit");
assert(nginx.includes("return 404;"), "metrics must not be exposed by public ingress");
assert(!nginx.includes("proxy_pass http://backend:8000/metrics"), "public ingress must not proxy backend metrics");
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

const directXlsxImport = /(?:from\s+["']xlsx["']|require\(\s*["']xlsx["']\s*\))/;
const allowedLegacyImport = path.resolve(root, "scripts/import-migration-xlsx.ts");
for (const absolute of walkFiles(root)) {
  if (!/\.(?:[cm]?[jt]s|tsx)$/.test(absolute)) continue;
  if (absolute.includes(`${path.sep}scripts${path.sep}xlsx-safe-package${path.sep}`)) continue;
  const source = fs.readFileSync(absolute, "utf8");
  if (!directXlsxImport.test(source)) continue;
  assert(
    absolute === allowedLegacyImport,
    `legacy xlsx dependency became reachable from an unguarded file: ${path.relative(root, absolute)}`,
  );
}
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
