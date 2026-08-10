import fs from "node:fs";
import path from "node:path";

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

console.log("SECURITY_REGRESSION_OK");
