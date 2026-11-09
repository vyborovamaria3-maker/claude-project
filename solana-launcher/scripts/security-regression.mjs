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

const devTwitter = read("app/api/trade/dev-twitter/route.ts");
assert(devTwitter.includes("export async function POST(req: NextRequest)"), "X collection must use POST");
const devTwitterGet = devTwitter.slice(devTwitter.indexOf("export async function GET()"));
assert(devTwitterGet.includes("status: 405"), "X collection GET must reject state-changing requests");
assert(!/scrapeTwitter|persistTwitterStats|getDb\(/.test(devTwitterGet), "X collection GET must not scrape or persist");

assert(devForensics.includes("export async function POST(req: NextRequest)"), "developer forensics refresh must use POST");
const devForensicsGet = devForensics.slice(devForensics.indexOf("export async function GET()"));
assert(devForensicsGet.includes("status: 405"), "developer forensics GET must reject refresh requests");
assert(!/upsertDevTokenVolume|fetch\(/.test(devForensicsGet), "developer forensics GET must not mutate or fetch external data");
assert(devForensics.includes('method: "POST"'), "internal X collection must use POST");

const fomoSnapshot = read("app/api/trade/fomo-snapshot/route.ts");
assert(fomoSnapshot.includes("POST as getTwitterStats"), "FOMO snapshot must invoke X collection through POST");
assert(fomoSnapshot.includes('method: "POST"'), "FOMO snapshot internal request must use POST");

for (const relativePath of [
  "components/trade/LiveIntelligencePanel.tsx",
  "components/trade/SocialIntelligencePanel.tsx",
  "components/trade/DevForensicsPanel.tsx",
  "components/chart/tabs/DevForensicsTab.tsx",
]) {
  const source = read(relativePath);
  assert(source.includes('method: "POST"'), relativePath + " must use POST for state-changing collection");
}

const socialIntelligenceClient = read("backend/app/services/social_intelligence.py");
assert(socialIntelligenceClient.includes("client.post("), "FastAPI social intelligence must call X collection with POST");
const twitterBridge = read("backend/app/cli/twitter_scrape_bridge.py");
assert(twitterBridge.includes("client.post(url, headers=headers)"), "Twitter scrape bridge must call X collection with POST");
const liveBacktest = read("scripts/social-ai-live-backtest.ps1");
assert(liveBacktest.includes("$xForced = Post-Json"), "live X Playwright test must use POST");
assert(liveBacktest.includes("$xAuto = Post-Json"), "live X auto test must use POST");

const walletSummaryRoute = read("app/api/database/wallets/route.ts");
assert(walletSummaryRoute.includes("getWalletSummaryStatus"), "wallet summary GET must check freshness");
assert(walletSummaryRoute.includes("status: 409"), "stale wallet summary must fail explicitly");
assert(!walletSummaryRoute.includes("rebuildWalletSummary("), "wallet summary GET must never rebuild aggregates");
const migrationImporter = read("scripts/import-migration-xlsx.ts");
assert(migrationImporter.includes("rebuildWalletSummary(db)"), "XLSX import must rebuild wallet summary after the batch");
const tradeDb = read("lib/trade/db.ts");
assert(tradeDb.includes("busy_timeout = 5000"), "SQLite connection must configure a busy timeout");
assert(tradeDb.includes("initializedDb"), "SQLite schema initialization must be cached per process");

const routeAuth = read("lib/routeAuth.ts");
assert(routeAuth.includes("hasValidInternalServiceKey"), "internal X calls need a dedicated service auth check");
assert(routeAuth.includes("timingSafeEqual"), "internal service credentials must be compared in constant time");
const proxy = read("proxy.ts");
assert(proxy.includes('"/api/trade/dev-twitter"'), "X collection must remain in the heavy rate-limit set");
assert(/pathname === "\/api\/trade\/dev-twitter"[\s\S]*request\.method === "POST"[\s\S]*hasValidInternalServiceKey\(request\)/.test(proxy),
  "only POST /api/trade/dev-twitter may use internal service authentication");

const socialClient = read("backend/app/services/social_intelligence.py");
assert(socialClient.includes('"x-internal-service-key"'), "FastAPI social client must authenticate internal collection");
assert(socialClient.includes("base != configured_internal"), "FastAPI must not forward the service key to an arbitrary frontend host");
assert(socialClient.includes("follow_redirects=False"), "FastAPI must not forward the service key across redirects");
const twitterBridgeClient = read("backend/app/cli/twitter_scrape_bridge.py");
assert(twitterBridgeClient.includes('"x-internal-service-key"'), "Twitter discovery bridge must authenticate internal collection");
assert(twitterBridgeClient.includes("candidate != configured_internal"), "CLI must not forward the service key to an arbitrary frontend host");
assert(!twitterBridgeClient.includes("follow_redirects=True"), "CLI must not forward service credentials across redirects");
const productionCompose = read("docker-compose.production.yml");
for (const serviceName of ["backend", "celery-worker", "twitter-discovery", "frontend"]) {
  const serviceStart = productionCompose.indexOf("\n  " + serviceName + ":\n");
  assert.notEqual(serviceStart, -1, "missing production service " + serviceName);
  const serviceBody = productionCompose.slice(serviceStart);
  const nextService = serviceBody.slice(1).search(/\n  [a-zA-Z0-9_-]+:\n/);
  const block = nextService < 0 ? serviceBody : serviceBody.slice(0, nextService + 1);
  assert(block.includes("INTERNAL_SERVICE_API_KEY"), serviceName + " must receive server-only internal key");
}
assert(read(".env.example").includes("INTERNAL_SERVICE_API_KEY="), "deployment env example must document internal service key");
assert(read("scripts/deploy-production.sh").includes("key=INTERNAL_SERVICE_API_KEY"), "deployment must generate/validate internal service key");
assert(!productionCompose.includes("NEXT_PUBLIC_INTERNAL_SERVICE_API_KEY"), "internal service key must never be exposed to browser bundles");
const walletSummaryHealth = read("app/api/internal/health/wallet-summary/route.ts");
assert(walletSummaryHealth.includes("hasValidInternalServiceKey"), "wallet summary health must require machine authentication");
assert(walletSummaryHealth.includes('status: 503'), "stale wallet summary must fail readiness");
assert(!walletSummaryHealth.includes("database_wallet_summary"), "health endpoint must not expose wallet aggregate rows");
const productionHealthcheck = read("scripts/healthcheck-production.sh");
assert(productionHealthcheck.includes("/api/internal/health/wallet-summary"), "deployment healthcheck must verify wallet summary readiness");
assert(productionHealthcheck.includes("x-internal-service-key"), "deployment healthcheck must authenticate the private readiness probe");

const postgresRoleProvisioner = read("scripts/provision-postgres-roles.sql");
assert(!/^\s*REASSIGN\s+OWNED\b/m.test(postgresRoleProvisioner), "role provisioner must never blanket-reassign existing object ownership");
assert(!/ALTER DATABASE .* OWNER TO/.test(postgresRoleProvisioner), "migrator must not become database owner");
assert(!postgresRoleProvisioner.includes("ALTER SCHEMA public OWNER"), "schema ownership transfer must remain a reviewed cutover");
assert(postgresRoleProvisioner.includes("NOBYPASSRLS NOINHERIT"), "all provisioned roles must be non-inheriting and must not bypass RLS");
assert(postgresRoleProvisioner.includes("REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC"), "new migration functions must not be executable by PUBLIC by default");
assert(postgresRoleProvisioner.includes("REVOKE CREATE ON SCHEMA public FROM PUBLIC"), "PUBLIC must not create objects in the app schema");
assert(postgresRoleProvisioner.includes("REVOKE CREATE ON DATABASE %I FROM %I"), "restricted roles must not retain database-level CREATE grants");
assert(postgresRoleProvisioner.includes("REVOKE CREATE ON SCHEMA %I FROM %I"), "runtime, backup and read-only roles must not retain schema CREATE grants");
assert(!postgresRoleProvisioner.includes("REVOKE ALL ON DATABASE"), "provisioner must preserve unrelated PUBLIC database ACLs pending inventory");
assert(!postgresRoleProvisioner.includes("REVOKE ALL ON SCHEMA public"), "provisioner must preserve unrelated schema USAGE grants");
assert(!/\bGRANT\s+pg_read_all_data\b/i.test(postgresRoleProvisioner), "backup role must use explicit SELECT grants, not a broad predefined role");
assert(postgresRoleProvisioner.includes('GRANT SELECT ON ALL TABLES IN SCHEMA public TO :"backup_user"'),
  "backup role must receive explicit table SELECT grants");
const migratorOwnershipGuard = read("scripts/check-postgres-migrator-ownership.sql");
assert(migratorOwnershipGuard.includes("extension_members"), "migrator guard must identify extension-managed objects");
assert(migratorOwnershipGuard.includes("non_migrator_object_count"), "migrator guard must block legacy-owned application objects");
assert(migratorOwnershipGuard.includes("unsupported_application_schema_count"), "non-public application schemas must block until explicitly provisioned");
assert(migratorOwnershipGuard.includes("migrator_can_create_database"), "migrator guard must reject database-level CREATE");
assert(migratorOwnershipGuard.includes("app_schemas_without_create"), "migrator guard must verify CREATE on every application schema");
assert(migratorOwnershipGuard.includes("restricted_database_create_count"), "runtime, backup and read-only roles must not have database CREATE");
assert(migratorOwnershipGuard.includes("restricted_schemas_with_create"), "runtime, backup and read-only roles must not have application-schema CREATE");
assert(migratorOwnershipGuard.includes("\\quit 3"), "migrator ownership guard must fail closed");
const deployScript = read("scripts/deploy-production.sh");
assert(deployScript.includes("check-postgres-migrator-ownership.sql"), "production deployment must run the read-only migrator ownership guard");
assert(deployScript.includes('-v app_user="$POSTGRES_APP_USER"'), "deployment must pass the runtime identity to the ownership guard");
assert(deployScript.includes('-v backup_user="$POSTGRES_BACKUP_USER"'), "deployment must pass the backup identity to the ownership guard");
assert(deployScript.includes('-v readonly_user="$POSTGRES_READONLY_USER"'), "deployment must pass the read-only identity to the ownership guard");
assert(deployScript.includes('< "$DEPLOY_DIR/scripts/check-postgres-migrator-ownership.sql"'), "ownership guard SQL must be streamed from the host into the PostgreSQL container");
const backupCallIndex = deployScript.indexOf('"$BACKUP_SCRIPT"\n');
const ownershipGuardCallIndex = deployScript.indexOf('-U "$POSTGRES_BOOTSTRAP_USER" -d potapoff -f -');
const stopWritersIndex = deployScript.indexOf("stop_telegram", ownershipGuardCallIndex);
assert(backupCallIndex !== -1 && backupCallIndex < ownershipGuardCallIndex,
  "verified backup must precede the ownership cutover gate");
assert(ownershipGuardCallIndex !== -1 && stopWritersIndex !== -1 && ownershipGuardCallIndex < stopWritersIndex,
  "ownership gate must run before stopping writers");

const potapoffRoleRehearsal = read("../.github/scripts/test-potapoff-role-provisioner.sh");
assert(potapoffRoleRehearsal.includes("--network none"), "PostgreSQL role rehearsal must use an isolated container network");
assert(potapoffRoleRehearsal.includes("pg_dump"), "role rehearsal must verify the dedicated backup login can dump data");
const predeployWorkflow = read("../.github/workflows/potapoff-predeploy-gate.yml");
assert(predeployWorkflow.includes("test-potapoff-role-provisioner.sh"), "POTAPoff predeploy CI must run the role provisioner rehearsal");

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
