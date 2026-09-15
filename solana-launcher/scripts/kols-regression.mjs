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
const coverageApi = read("backend/app/api/v1/kols_coverage.py");
const apiRouter = read("backend/app/api/v1/router.py");
const backtestApi = read("backend/app/api/v1/kols_backtest.py");
const models = read("backend/app/models/kol_intelligence.py");
const migration = read("backend/alembic/versions/0012_kol_trade_events.py");
const ingestion = read("backend/app/services/kol_trade_ingestion.py");
const metrics = read("backend/app/services/kol_metrics.py");
const intelligence = read("backend/app/services/kol_intelligence.py");
const backtest = read("backend/app/services/kol_backtest.py");
const advanced = read("backend/app/api/v1/advanced_intelligence.py");
const kolTask = read("backend/app/tasks/kols.py");
const celery = read("backend/app/tasks/celery_app.py");
const compose = read("docker-compose.production.yml");
const localCompose = read("docker-compose.yml");
const deployProduction = read("scripts/deploy-production.sh");
const healthProduction = read("scripts/healthcheck-production.sh");
const envExample = read(".env.example");
const backendEnvExample = read("backend/.env.example");
const tests = read("backend/tests/test_kol_intelligence.py");
const backtestTests = read("backend/tests/test_kol_backtest.py");
const ingestionTests = read("backend/tests/test_kol_trade_ingestion.py");
const runtimeGuardTests = read("backend/tests/test_kol_runtime_guards.py");
const liveFeed = read("components/trade/KOLLiveTradeFeed.tsx");
const siteDesign = read("lib/siteDesign.ts");
const sidebar = read("components/SidebarNav.tsx");
const responsive = read("app/responsive.css");
const kolsPage = read("app/trade/kols-twitter/page.tsx");

const paidBlock = proxy.match(/const PAID_ROUTE_PREFIXES = \[([\s\S]*?)\];/)?.[1] ?? "";
const heavyBlock = proxy.match(/const HEAVY_ROUTE_PREFIXES = \[([\s\S]*?)\];/)?.[1] ?? "";
assert(paidBlock.includes('"/api/kols"'), "/api/kols must stay behind paid authentication");
assert(heavyBlock.includes('"/api/kols"'), "/api/kols must stay behind the heavy-route rate limit");
assert(
  proxy.includes('{ prefix: "/api/kols/backtest", limit: 3 }')
    && proxy.includes("VERY_HEAVY_ROUTE_LIMITS"),
  "expensive KOL backtests must keep their stricter per-minute rate limit",
);

assert(
  siteDesign.includes('{ href: "/trade/kols-twitter", labelKey: "nav.xAnalysis", icon: "twitter", tag: "nav.kols_twitter" }'),
  "KOLs Twitter must remain part of the shared trade navigation config",
);
assert(!sidebar.includes("KOLS_TWITTER_NAV_ITEM"), "Sidebar must not maintain a second ad-hoc KOL navigation source");
assert(
  responsive.includes('[data-tag="trade.kols_twitter"] .site-table tr')
    && responsive.includes("grid-template-columns: minmax(0, 1fr) auto"),
  "mobile KOL leaderboard must keep its card layout instead of a wide desktop table",
);
assert(responsive.includes('[data-tag="trade.kols_backtest"]'), "KOL backtest must stay inside responsive safeguards");
assert(
  kolsPage.indexOf("<KolsTwitterPanel />") < kolsPage.indexOf("<KOLTokenFlowPanel />")
    && kolsPage.includes("<KOLBacktestPanel />")
    && kolsPage.includes("<KOLLiveTradeFeed />"),
  "KOL workspace must keep directory, token flow, live feed and backtest integrated",
);

assert(
  resolver.includes('const NEXT_ID_PROOF_URL = "https://proof-service.next.id/v1/proof"')
    && resolver.includes("proof.is_valid === true"),
  "Next.ID resolver must use the production service and require a valid proof",
);
assert(!resolver.includes("proof-service.nextnext.id"), "Next.ID staging endpoint must not be used");
assert(resolver.includes("bs58.decode(trimmed).length === 32"), "Solana identities must be valid 32-byte public keys");
assert(
  /chain\s*===\s*"solana"\s*\?\s*left\s*===\s*right/.test(resolver)
    && !resolver.includes("wallet.address.toLowerCase() === incoming.address.toLowerCase()"),
  "Solana wallet equality must remain case-sensitive",
);
assert(
  resolver.includes("resolveFromFireflyWallet")
    && resolver.includes('"walletAddress"')
    && resolver.includes('"solanaAddress"')
    && resolver.includes("twitterProfiles"),
  "wallet search must reverse-resolve EVM and Solana wallets through Firefly",
);
assert(
  resolver.includes("signal: AbortSignal.timeout(6_000)")
    && resolver.includes("signal: AbortSignal.timeout(8_000)"),
  "external providers must stay bounded by timeouts",
);

assert(
  nextRoute.includes("new Map(\n      (data.items ?? []).map((item) => [item.address, item.metrics] as const)")
    && nextRoute.includes("const metrics = lookup.get(wallet.address)")
    && !nextRoute.includes("item.address.toLowerCase(), item.metrics"),
  "internal Solana metric joins must remain exact and case-sensitive",
);
assert(
  nextRoute.includes("/api/v1/kols/internal/trade-coverage")
    && nextRoute.includes('source: "KOL trade ingestion"')
    && nextRoute.includes('source: "Internal KOL event metrics"'),
  "main KOL API must surface event ingestion coverage and event-derived metrics",
);

assert(internalApi.includes('alias="X-KOL-Internal-Key"'), "internal KOL endpoints must require the scoped key");
assert(
  internalApi.includes("len(expected) < 32")
    && internalApi.includes("hmac.compare_digest(expected, backend_key)"),
  "production KOL internal key must be strong and distinct from the backend master key",
);
assert(
  internalApi.includes("KOLTradeEvent")
    && internalApi.includes("best_by_event")
    && internalApi.includes('"source": "kol_trade_events"'),
  "live KOL feed must use granular events and one canonical attribution per event",
);
assert(
  internalApi.includes('@router.post("/internal/sync-trades")')
    && internalApi.includes("sync_kol_trade_events")
    && internalApi.includes("refresh_kol_metrics"),
  "manual scoped diagnostics must support bounded trade sync plus metric refresh",
);

assert(
  models.includes('class KOLTradeEvent(Base):')
    && models.includes('name="uq_kol_trade_event_wallet_tx_index"')
    && models.includes('class KOLTradeSyncState(Base):')
    && models.includes("next_cursor")
    && models.includes("backfill_complete"),
  "KOL event ledger must keep DB-level idempotency and cursor backfill state",
);
assert(
  migration.includes('revision = "0012_kol_trade_events"')
    && migration.includes('down_revision = "0011_kol_intelligence"')
    && migration.includes('"kol_trade_events"')
    && migration.includes('"next_cursor"')
    && migration.includes('"backfill_complete"'),
  "Alembic chain must create the event ledger and backfill state after 0011",
);

assert(
  ingestion.includes('/wallet/{quote(address, safe=\'\')}/trades')
    && ingestion.includes('"x-api-key": api_key')
    && ingestion.includes('params = {"cursor": cursor} if cursor else None')
    && ingestion.includes('"nextCursor"')
    && ingestion.includes('"hasNextPage"'),
  "Solana Tracker ingestion must use authenticated cursor pagination",
);
assert(
  ingestion.includes("SOLANA_TRACKER_API_KEY")
    && ingestion.includes("KOL_TRADE_SYNC_WALLETS_PER_RUN")
    && ingestion.includes("state.backfill_complete")
    && ingestion.includes("state.next_cursor"),
  "trade ingestion must stay quota-aware and persist historical backfill progress",
);
assert(
  ingestion.includes("session.begin_nested()")
    && ingestion.includes("except IntegrityError")
    && ingestion.includes("with_for_update()"),
  "event writes and cursor state must tolerate concurrent manual/scheduled ingestion",
);
assert(
  ingestion.includes('side="sell"') && ingestion.includes('side="buy"'),
  "normalizer must preserve both sides of token-to-token swaps",
);
assert(
  ingestion.includes('"Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"')
    && !ingestion.includes("_BASE_SYMBOLS"),
  "base-asset classification must use canonical mints instead of spoofable symbols",
);

assert(
  intelligence.includes("canonical_kol_event_rows")
    && intelligence.includes("KOLTradeEvent")
    && intelligence.includes('"event_source": "kol_trade_events"'),
  "token KOL flow must count each on-chain event once using canonical attribution",
);
assert(
  intelligence.includes('"jaccard_unique_token_participation"')
    && intelligence.includes('"ownership_claim": False')
    && intelligence.includes("max(0.0, min(1.0, similarity))"),
  "related wallets must stay bounded behavioral evidence, never ownership claims",
);
assert(
  metrics.includes("KOLTradeEvent")
    && metrics.includes("_fifo_realized")
    && metrics.includes('_METRIC_SOURCE = "internal_kol_events"')
    && metrics.includes('"stale_cleared": len(recent) == 0'),
  "KOL metrics must derive from event-ledger FIFO and clear stale windows",
);
assert(
  metrics.includes("fully_matched") && metrics.includes("fully_priced") && metrics.includes("else None"),
  "FIFO PnL must reject partial or unpriced sell cost basis",
);
assert(
  metrics.includes("transaction_values: dict[str, float] = {}")
    && metrics.includes("metric.trade_count = len(transaction_signatures)")
    && metrics.includes('"event_count": len(recent)'),
  "wallet metrics must count one transaction/notional per signature while retaining event granularity",
);

assert(
  kolTask.includes("_REFRESH_LOCK_KEY")
    && kolTask.includes("_TRADE_SYNC_LOCK_KEY")
    && kolTask.includes("lock.acquire(blocking=False)")
    && kolTask.includes("_TRADE_SYNC_LOCK_TTL_SECONDS"),
  "metric refresh and trade ingestion must use distributed singleton locks",
);
assert(
  celery.includes('"sync-kol-trade-events"')
    && celery.includes('"app.tasks.kols.sync_trade_events"')
    && celery.includes("KOL_TRADE_SYNC_INTERVAL_SECONDS"),
  "Celery Beat must schedule quota-aware KOL event ingestion",
);
assert(
  advanced.includes("_safe_kol_intelligence") && advanced.includes('"status": "unavailable"'),
  "KOL enrichment must fail open without breaking Advanced Intelligence",
);

assert(
  coverageApi.includes("KOLTradeEvent")
    && coverageApi.includes("KOLTradeSyncState")
    && coverageApi.includes('"ingestion_disabled"')
    && coverageApi.includes('"ingestion_missing"'),
  "coverage endpoint must distinguish missing/disabled ingestion from KOL inactivity",
);
assert(
  apiRouter.includes("kols_coverage") && apiRouter.includes("kols_coverage.router"),
  "trade coverage endpoint must be registered in the API router",
);

assert(
  backtestRoute.includes('"X-KOL-Internal-Key": KOL_INTERNAL_KEY')
    && backtestRoute.includes("ALLOWED_PARAMS"),
  "backtest proxy must use the scoped KOL key and explicit query allowlist",
);
assert(
  backtestApi.includes("_require_kol_internal_key") && backtestApi.includes("backtest_kol_signals"),
  "backend backtest endpoint must require the scoped KOL key",
);
assert(
  backtest.includes("KOLTradeEvent")
    && backtest.includes('"baselineSource": "token_metric_before_signal"')
    && !backtest.includes("trigger_trade_fallback"),
  "backtest must use granular events while sourcing entry only from pre-signal market metrics",
);
assert(
  backtest.includes("signalsSkippedNoBaseline")
    && backtest.includes("last_signal_at = timestamp\n                continue")
    && backtest.includes("_price_at_or_before(")
    && backtest.includes("_price_at_or_after("),
  "backtest must preserve trigger timing and explicit past/future price boundaries",
);
assert(
  backtest.includes("all_signals")
    && backtest.includes("returned_signals = all_signals[:max_signals]")
    && backtest.includes('"uniqueEvents"'),
  "backtest summary must use the full event-derived sample and truncate only details",
);
assert(
  backtest.includes("current KOL attribution snapshot is applied to historical events")
    && backtest.includes("first_seen_at = _aware(attribution.first_seen_at)"),
  "backtest must disclose attribution bias and support strict event-time attribution",
);

const frontendService = compose.match(/\n  frontend:\n([\s\S]*?)\n  telegram-bot:\n/)?.[1] ?? "";
const backendService = compose.match(/\n  backend:\n([\s\S]*?)\n  celery-worker:\n/)?.[1] ?? "";
const workerService = compose.match(/\n  celery-worker:\n([\s\S]*?)\n  celery-beat:\n/)?.[1] ?? "";
const beatService = compose.match(/\n  celery-beat:\n([\s\S]*?)\n  telegram-intelligence:\n/)?.[1] ?? "";
assert(frontendService.includes("KOL_INTERNAL_KEY"), "frontend server must receive the scoped KOL proxy key");
assert(!frontendService.includes("BACKEND_API_KEY"), "frontend must not receive the backend master key");
assert(!frontendService.includes("SOLANA_TRACKER_API_KEY"), "frontend must never receive the provider API key");
assert(backendService.includes("KOL_INTERNAL_KEY"), "backend must receive the scoped KOL key");
assert(
  backendService.includes("SOLANA_TRACKER_API_KEY")
    && workerService.includes("SOLANA_TRACKER_API_KEY")
    && beatService.includes("KOL_TRADE_SYNC_INTERVAL_SECONDS"),
  "backend/worker/beat must receive the server-side trade-ingestion configuration",
);
assert(
  compose.includes("\n  celery-beat:\n")
    && compose.includes('"beat", "--loglevel=info", "--schedule=/tmp/celerybeat-schedule"'),
  "production Compose must run Celery Beat",
);
assert(
  deployProduction.includes("resolve_env_value()")
    && deployProduction.includes("KOL_INTERNAL_KEY must be at least 32 characters")
    && deployProduction.includes("KOL_INTERNAL_KEY must be different from BACKEND_API_KEY")
    && deployProduction.includes("export SOLANA_TRACKER_API_KEY"),
  "production deploy must fail closed on the scoped KOL key and preserve optional provider env",
);
assert(
  healthProduction.includes("celery-beat")
    && healthProduction.includes("KOL_INTERNAL_KEY must be at least 32 characters")
    && healthProduction.includes("kol_ingestion=$kol_ingestion"),
  "production healthcheck must require Celery Beat and report KOL ingestion state",
);

const localBackendService = localCompose.match(/\n  backend:\n([\s\S]*?)\n  celery-worker:\n/)?.[1] ?? "";
const localWorkerService = localCompose.match(/\n  celery-worker:\n([\s\S]*?)\n  celery-beat:\n/)?.[1] ?? "";
const localFrontendService = localCompose.match(/\n  frontend:\n([\s\S]*?)\n  nginx:\n/)?.[1] ?? "";
assert(localBackendService.includes("KOL_INTERNAL_KEY"), "local backend must receive the scoped KOL key");
assert(localFrontendService.includes("KOL_INTERNAL_KEY"), "local frontend server must receive the scoped KOL key");
assert(!localFrontendService.includes("SOLANA_TRACKER_API_KEY"), "local frontend must not receive provider secrets");
assert(
  localBackendService.includes("SOLANA_TRACKER_API_KEY")
    && localWorkerService.includes("SOLANA_TRACKER_API_KEY")
    && localCompose.includes("\n  celery-beat:\n"),
  "local Compose must wire ingestion and run Celery Beat",
);
assert(
  envExample.includes("KOL_INTERNAL_KEY=")
    && envExample.includes("SOLANA_TRACKER_API_KEY=")
    && envExample.includes("KOL_TRADE_SYNC_INTERVAL_SECONDS=1200")
    && !envExample.includes("KOL_INTERNAL_KEY=dev-"),
  "Compose env example must document scoped credentials and conservative ingestion defaults",
);
assert(
  backendEnvExample.includes("KOL_INTERNAL_KEY=")
    && backendEnvExample.includes("SOLANA_TRACKER_API_KEY=")
    && !backendEnvExample.includes("KOL_INTERNAL_KEY=dev-"),
  "backend env template must document standalone KOL ingestion settings",
);

assert(
  !liveFeed.includes("локальных wallet_trades")
    && liveFeed.includes("event ledger")
    && liveFeed.includes("отсутствие истории не означает"),
  "live feed must describe missing event coverage honestly",
);
assert(
  tests.includes("test_shared_wallet_event_is_counted_once")
    && tests.includes("test_refresh_clears_stale_internal_event_metric")
    && tests.includes("test_partial_sync_preserves_verified_profile_data")
    && tests.includes("test_internal_sync_requires_scoped_key"),
  "backend tests must protect event dedupe, stale clearing, strong attribution and scoped auth",
);
assert(
  ingestionTests.includes("test_normalize_base_to_token_as_buy")
    && ingestionTests.includes("test_normalize_token_to_base_as_sell")
    && ingestionTests.includes("test_normalize_token_to_token_preserves_both_legs")
    && ingestionTests.includes("test_symbol_spoof_does_not_turn_arbitrary_token_into_base_asset")
    && ingestionTests.includes("test_fifo_realized_refuses_partial_or_unpriced_cost_basis"),
  "trade ingestion tests must cover directionality, symbol spoofing and conservative FIFO PnL",
);
assert(
  runtimeGuardTests.includes("test_production_kol_key_rejects_short_secret")
    && runtimeGuardTests.includes("test_production_kol_key_must_differ_from_backend_master")
    && runtimeGuardTests.includes("test_refresh_metrics_skips_when_distributed_lock_is_held")
    && runtimeGuardTests.includes("test_refresh_metrics_releases_lock_after_success")
    && runtimeGuardTests.includes("test_trade_sync_skips_when_distributed_lock_is_held"),
  "runtime guard tests must cover scoped-key hardening and both distributed KOL locks",
);
assert(
  backtestTests.includes("test_backtest_builds_signal_without_future_price_leakage")
    && backtestTests.includes("test_backtest_skips_trigger_without_pre_signal_market_price")
    && backtestTests.includes("test_backtest_dedupes_multiple_labels_for_one_event")
    && backtestTests.includes("test_strict_attribution_time_excludes_pre_attribution_events"),
  "backtest tests must cover event dedupe, strict attribution and no price lookahead",
);

console.log("KOLS_REGRESSION_OK");