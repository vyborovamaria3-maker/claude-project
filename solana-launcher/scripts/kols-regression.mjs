import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(`[kols-regression] ${message}`);
};

const proxy = read("proxy.ts");
const siteDesign = read("lib/siteDesign.ts");
const sidebar = read("components/SidebarNav.tsx");
const router = read("backend/app/api/v1/router.py");
const models = read("backend/app/models/kol_intelligence.py");
const migration23 = read("backend/alembic/versions/0023_kol_intelligence.py");
const migration24 = read("backend/alembic/versions/0024_kol_trade_events.py");
const internalApi = read("backend/app/api/v1/kols_internal.py");
const coverageApi = read("backend/app/api/v1/kols_coverage.py");
const ingestion = read("backend/app/services/kol_trade_ingestion.py");
const metrics = read("backend/app/services/kol_metrics.py");
const intelligence = read("backend/app/services/kol_intelligence.py");
const backtest = read("backend/app/services/kol_backtest.py");
const advanced = read("backend/app/api/v1/advanced_intelligence.py");
const tasks = read("backend/app/tasks/kols.py");
const celery = read("backend/app/tasks/celery_app.py");
const page = read("app/trade/kols-twitter/page.tsx");
const resolver = read("lib/kols/resolver.ts");

assert(proxy.includes('"/api/kols"'), "KOL API must remain protected and rate limited");
assert(
  proxy.includes('{ prefix: "/api/kols/backtest", limit: 3 }'),
  "KOL backtest must keep its strict rate limit",
);
assert(
  siteDesign.includes('{ href: "/trade/kols-twitter", labelKey: "nav.xAnalysis", icon: "twitter", tag: "nav.kols_twitter" }'),
  "KOL workspace must be registered in shared trade navigation",
);
assert(!sidebar.includes("KOLS_TWITTER_NAV_ITEM"), "Sidebar must use shared navigation only");
assert(
  page.includes("<KolsTwitterPanel />") &&
    page.includes("<KOLTokenFlowPanel />") &&
    page.includes("<KOLBacktestPanel />") &&
    page.includes("<KOLLiveTradeFeed />"),
  "KOL workspace must include directory, token flow, backtest and live feed",
);

assert(
  migration23.includes('revision = "0023_kol_intelligence"') &&
    migration23.includes('down_revision = "0022_merge_discovery_lock"'),
  "KOL schema must extend the canonical production Alembic head",
);
assert(
  migration24.includes('revision = "0024_kol_trade_events"') &&
    migration24.includes('down_revision = "0023_kol_intelligence"') &&
    migration24.includes('"kol_trade_events"') &&
    migration24.includes('"next_cursor"') &&
    migration24.includes('"backfill_complete"'),
  "KOL event ledger must be the next canonical migration",
);
assert(
  models.includes("class KOLTradeEvent") &&
    models.includes("class KOLTradeSyncState") &&
    models.includes('name="uq_kol_trade_event_wallet_tx_index"'),
  "KOL event ledger must keep database idempotency and sync state",
);

assert(router.includes("kols_coverage.router") && router.includes("kols_backtest.router"), "KOL routers must be registered");
assert(internalApi.includes('alias="X-KOL-Internal-Key"'), "KOL internal API must use scoped auth");
assert(
  internalApi.includes("len(expected) < 32") && internalApi.includes("hmac.compare_digest(expected, backend_key)"),
  "KOL key must be strong and distinct from the backend master key",
);
assert(
  coverageApi.includes("KOLTradeEvent") && coverageApi.includes("KOLTradeSyncState"),
  "KOL coverage must reflect event ingestion state",
);
assert(
  ingestion.includes("SOLANA_TRACKER_API_KEY") &&
    ingestion.includes("session.begin_nested()") &&
    ingestion.includes("with_for_update()") &&
    ingestion.includes("next_cursor"),
  "KOL ingestion must be authenticated, resumable and concurrency safe",
);
assert(
  metrics.includes("KOLTradeEvent") && metrics.includes("_fifo_realized") && metrics.includes("internal_kol_events"),
  "KOL metrics must derive from the event ledger",
);
assert(
  intelligence.includes("canonical_kol_event_rows") && intelligence.includes('"ownership_claim": False'),
  "KOL intelligence must deduplicate events and avoid ownership claims",
);
assert(
  backtest.includes("KOLTradeEvent") &&
    backtest.includes('"baselineSource": "token_metric_before_signal"') &&
    !backtest.includes("trigger_trade_fallback"),
  "KOL backtest must avoid future-price leakage",
);
assert(
  tasks.includes("_REFRESH_LOCK_KEY") &&
    tasks.includes("_TRADE_SYNC_LOCK_KEY") &&
    tasks.includes("lock.acquire(blocking=False)"),
  "KOL scheduled jobs must retain distributed singleton locks",
);
assert(
  celery.includes('"sync-kol-trade-events"') &&
    celery.includes('"app.tasks.kols.sync_trade_events"') &&
    celery.includes("KOL_TRADE_SYNC_INTERVAL_SECONDS"),
  "Celery Beat must schedule KOL ingestion",
);
assert(
  advanced.includes("_safe_kol_intelligence") && advanced.includes('"status": "unavailable"'),
  "Advanced Intelligence must fail open when optional KOL enrichment fails",
);
assert(
  resolver.includes('const NEXT_ID_PROOF_URL = "https://proof-service.next.id/v1/proof"') &&
    resolver.includes("bs58.decode(trimmed).length === 32") &&
    resolver.includes("AbortSignal.timeout"),
  "KOL identity resolution must use production providers with bounded requests",
);

for (const path of [
  "backend/tests/test_kol_intelligence.py",
  "backend/tests/test_kol_backtest.py",
  "backend/tests/test_kol_coverage.py",
  "backend/tests/test_kol_trade_ingestion.py",
  "backend/tests/test_kol_runtime_guards.py",
]) {
  assert(read(path).length > 500, `${path} must remain substantive`);
}

console.log("KOLS_REGRESSION_OK");
