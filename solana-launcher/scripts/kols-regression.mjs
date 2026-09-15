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
const backtestRoute = read("app/api/kols/backtest/route.ts");
const internalApi = read("backend/app/api/v1/kols_internal.py");
const backtestApi = read("backend/app/api/v1/kols_backtest.py");
const metrics = read("backend/app/services/kol_metrics.py");
const intelligence = read("backend/app/services/kol_intelligence.py");
const backtest = read("backend/app/services/kol_backtest.py");
const advanced = read("backend/app/api/v1/advanced_intelligence.py");
const compose = read("docker-compose.production.yml");
const localCompose = read("docker-compose.yml");
const envExample = read(".env.example");
const tests = read("backend/tests/test_kol_intelligence.py");
const backtestTests = read("backend/tests/test_kol_backtest.py");
const siteDesign = read("lib/siteDesign.ts");
const sidebar = read("components/SidebarNav.tsx");
const responsive = read("app/responsive.css");
const kolsPage = read("app/trade/kols-twitter/page.tsx");

const paidBlock = proxy.match(/const PAID_ROUTE_PREFIXES = \[([\s\S]*?)\];/)?.[1] ?? "";
const heavyBlock = proxy.match(/const HEAVY_ROUTE_PREFIXES = \[([\s\S]*?)\];/)?.[1] ?? "";
assert(paidBlock.includes('"/api/kols"'), "/api/kols must stay behind paid authentication");
assert(heavyBlock.includes('"/api/kols"'), "/api/kols must stay behind the heavy-route rate limit");

assert(
  siteDesign.includes('{ href: "/trade/kols-twitter", labelKey: "nav.xAnalysis", icon: "twitter", tag: "nav.kols_twitter" }'),
  "KOLs Twitter must remain part of the shared trade navigation config",
);
assert(
  !sidebar.includes("KOLS_TWITTER_NAV_ITEM"),
  "Sidebar must not maintain a second ad-hoc KOL navigation source",
);
assert(
  responsive.includes('[data-tag="trade.kols_twitter"] .site-table tr')
    && responsive.includes("grid-template-columns: minmax(0, 1fr) auto"),
  "mobile KOL leaderboard must keep its card layout instead of a wide desktop table",
);
assert(
  responsive.includes('[data-tag="trade.kols_backtest"]'),
  "KOL backtest must stay inside the shared responsive safeguards",
);
assert(
  kolsPage.indexOf("<KolsTwitterPanel />") < kolsPage.indexOf("<KOLTokenFlowPanel />")
    && kolsPage.includes("<KOLBacktestPanel />"),
  "KOL tab must lead with the directory and keep backtest integrated in the same workspace",
);

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

assert(
  backtestRoute.includes('"X-KOL-Internal-Key": KOL_INTERNAL_KEY')
    && backtestRoute.includes("ALLOWED_PARAMS"),
  "backtest proxy must use the scoped KOL key and an explicit query allowlist",
);
assert(
  backtestApi.includes("_require_kol_internal_key")
    && backtestApi.includes("backtest_kol_signals"),
  "backend backtest endpoint must require the scoped KOL key",
);
assert(
  backtest.includes('baseline_source = "token_metric_before_signal"')
    && !backtest.includes("trigger_trade_fallback"),
  "backtest entry must come only from a timestamped market price at/before the signal",
);
assert(
  backtest.includes("signalsSkippedNoBaseline")
    && backtest.includes("last_signal_at = timestamp\n                continue"),
  "signals without a pre-trigger market price must be excluded without shifting their trigger timeline",
);
assert(
  backtest.includes("_price_at_or_before(")
    && backtest.includes("_price_at_or_after(")
    && backtest.includes('"lookaheadGuard"'),
  "backtest must keep explicit before/after price boundaries and document lookahead protection",
);
assert(
  backtest.includes("all_signals")
    && backtest.includes("returned_signals = all_signals[:max_signals]"),
  "backtest summary must use the full signal sample while truncating only response detail",
);
assert(
  backtest.includes("current KOL attribution snapshot is applied to historical trades"),
  "backtest must disclose current-attribution selection bias",
);
assert(
  backtest.includes("canonical_events") && backtest.includes("first_seen_at = _aware(attribution.first_seen_at)"),
  "backtest strict mode must choose attribution at each historical buy/sell event time",
);

const frontendService = compose.match(/\n  frontend:\n([\s\S]*?)\n  telegram-bot:\n/)?.[1] ?? "";
const backendService = compose.match(/\n  backend:\n([\s\S]*?)\n  celery-worker:\n/)?.[1] ?? "";
assert(frontendService.includes("KOL_INTERNAL_KEY"), "frontend server must receive the scoped KOL key");
assert(!frontendService.includes("BACKEND_API_KEY"), "frontend must not receive the backend master key");
assert(backendService.includes("KOL_INTERNAL_KEY"), "backend must receive the scoped KOL key");
assert(
  compose.includes("\n  celery-beat:\n")
    && compose.includes('"beat", "--loglevel=info", "--schedule=/tmp/celerybeat-schedule"'),
  "production Compose must run Celery Beat so KOL refresh schedules actually execute",
);

const localBackendService = localCompose.match(/\n  backend:\n([\s\S]*?)\n  celery-worker:\n/)?.[1] ?? "";
const localFrontendService = localCompose.match(/\n  frontend:\n([\s\S]*?)\n  nginx:\n/)?.[1] ?? "";
assert(
  localBackendService.includes("KOL_INTERNAL_KEY"),
  "local Compose backend must receive the scoped KOL key in production-mode containers",
);
assert(
  localFrontendService.includes("KOL_INTERNAL_KEY"),
  "local Compose frontend server must receive the scoped KOL key",
);
assert(
  localCompose.includes("\n  celery-beat:\n")
    && localCompose.includes('"beat", "--loglevel=info", "--schedule=/tmp/celerybeat-schedule"'),
  "local Compose must run Celery Beat so scheduled KOL refresh is testable",
);
assert(
  envExample.includes("KOL_INTERNAL_KEY=") && !envExample.includes("KOL_INTERNAL_KEY=dev-"),
  "Compose env example must document a required blank scoped KOL key without a source-controlled default",
);

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
assert(
  backtestTests.includes("test_backtest_builds_signal_without_future_price_leakage"),
  "backtest tests must cover historical price lookahead leakage",
);
assert(
  backtestTests.includes("test_backtest_skips_trigger_without_pre_signal_market_price"),
  "backtest tests must reject triggers that only have post-signal pricing",
);
assert(
  backtestTests.includes("test_backtest_dedupes_multiple_labels_for_one_trade"),
  "backtest tests must cover duplicate identity labels on one WalletTrade",
);
assert(
  backtestTests.includes("test_strict_attribution_time_excludes_pre_attribution_trades"),
  "backtest tests must cover strict attribution timing",
);

console.log("KOLS_REGRESSION_OK");
