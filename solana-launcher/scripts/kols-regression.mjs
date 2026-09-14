import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(`[kols-regression] ${message}`);
}

const proxy = read("proxy.ts");
const resolver = read("lib/kols/resolver.ts");
const nextRoute = read("app/api/kols/route.ts");
const internalApi = read("backend/app/api/v1/kols_internal.py");
const metrics = read("backend/app/services/kol_metrics.py");
const intelligence = read("backend/app/services/kol_intelligence.py");
const advanced = read("backend/app/api/v1/advanced_intelligence.py");
const compose = read("docker-compose.production.yml");
const tests = read("backend/tests/test_kol_intelligence.py");

const paidBlock = proxy.match(/const PAID_ROUTE_PREFIXES = \[([\s\S]*?)\];/)?.[1] ?? "";
const heavyBlock = proxy.match(/const HEAVY_ROUTE_PREFIXES = \[([\s\S]*?)\];/)?.[1] ?? "";
assert(paidBlock.includes('"/api/kols"'), "/api/kols must stay behind paid authentication");
assert(heavyBlock.includes('"/api/kols"'), "/api/kols must stay behind the heavy-route rate limit");

assert(
  resolver.includes('const NEXT_ID_PROOF_URL = "https://proof-service.next.id/v1/proof"'),
  "Next.ID resolver must use the production proof service",
);
assert(
  !resolver.includes("proof-service.nextnext.id"),
  "Next.ID staging endpoint must not be used in production resolver code",
);
assert(
  resolver.includes("proof.is_valid === true"),
  "Next.ID wallet attribution must require an explicitly valid proof",
);
assert(
  resolver.includes("bs58.decode(trimmed).length === 32"),
  "Solana identities must be validated as real 32-byte base58 public keys",
);
assert(
  resolver.includes('chain === "solana"\n    ? left === right'),
  "Solana wallet equality must remain case-sensitive",
);
assert(
  !resolver.includes("wallet.address.toLowerCase() === incoming.address.toLowerCase()"),
  "resolver must never case-fold Solana addresses while merging identities",
);
assert(
  resolver.includes("signal: AbortSignal.timeout(6_000)")
    && resolver.includes("signal: AbortSignal.timeout(8_000)"),
  "external identity/data providers must stay bounded by timeouts",
);

assert(
  nextRoute.includes("new Map(\n      (data.items ?? []).map((item) => [item.address, item.metrics] as const)"),
  "internal Solana metric joins must use the exact case-sensitive address",
);
assert(
  nextRoute.includes("const metrics = lookup.get(wallet.address)"),
  "internal Solana metric lookup must not lowercase addresses",
);
assert(
  !nextRoute.includes("item.address.toLowerCase(), item.metrics"),
  "internal metric index must not case-fold Solana addresses",
);

assert(
  internalApi.includes('alias="X-KOL-Internal-Key"'),
  "internal KOL backend endpoints must require the scoped KOL key",
);
assert(
  internalApi.includes("best_by_trade"),
  "live KOL trades must deduplicate a shared wallet to one canonical attribution",
);
assert(
  intelligence.includes("canonical_kol_trade_rows"),
  "token KOL flow must count each WalletTrade only once",
);
assert(
  metrics.includes(".outerjoin(") && metrics.includes('"stale_cleared": trade_count == 0'),
  "KOL metric refresh must include inactive wallets and clear stale windows",
);
assert(
  advanced.includes("_safe_kol_intelligence") && advanced.includes('"status": "unavailable"'),
  "KOL enrichment must fail open without breaking Advanced Intelligence",
);

const frontendService = compose.match(/\n  frontend:\n([\s\S]*?)\n  telegram-bot:\n/)?.[1] ?? "";
const backendService = compose.match(/\n  backend:\n([\s\S]*?)\n  celery-worker:\n/)?.[1] ?? "";
assert(frontendService.includes("KOL_INTERNAL_KEY"), "frontend server must receive the scoped KOL key");
assert(!frontendService.includes("BACKEND_API_KEY"), "frontend must not receive the backend master key");
assert(backendService.includes("KOL_INTERNAL_KEY"), "backend must receive the scoped KOL key");

assert(
  tests.includes("test_shared_wallet_trade_is_counted_once"),
  "backend tests must cover shared-wallet double counting",
);
assert(
  tests.includes("test_refresh_clears_stale_internal_metric"),
  "backend tests must cover stale metric clearing",
);
assert(
  tests.includes("test_partial_sync_preserves_verified_profile_data"),
  "backend tests must protect stronger attribution evidence from partial syncs",
);
assert(
  tests.includes("test_internal_sync_requires_scoped_key"),
  "backend tests must cover scoped internal KOL authentication",
);

console.log("KOLS_REGRESSION_OK");
