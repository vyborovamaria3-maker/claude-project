import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const panel = read("components", "trade", "SocialIntelligencePanel.tsx");
const socialTypes = read("lib", "trade", "social-intelligence.ts");
const scraper = read("lib", "trade", "twitter-scraper.ts");
const compose = read("docker-compose.yml");
const dockerfile = read("Dockerfile.frontend.prod");
const telegramRuntimePath = join(root, "backend", "app", "services", "telegram_runtime.py");
const telegramRuntime = existsSync(telegramRuntimePath)
  ? readFileSync(telegramRuntimePath, "utf8")
  : "";
const healthRoute = read("app", "api", "trade", "source-health", "route.ts");

assert(panel.includes("const [aiLoading, setAiLoading]"), "AI loading must be independent from source loading");
assert(panel.includes('const needX = !compact || mode === "all" || mode === "twitter" || mode === "ai"'), "Twitter tab must not fetch every source");
assert(panel.includes('const needTg = !compact || mode === "all" || mode === "telegram" || mode === "ai"'), "Telegram tab must not fetch every source");
assert(panel.indexOf("setLoading(false);") < panel.indexOf("setAiLoading(true);"), "source UI must render before slow AI starts");
assert(panel.includes('wide.delete("hours")'), "empty social windows must retry with wider history");
assert(panel.includes("TelegramCollectorStatus"), "Telegram empty responses must expose collector diagnostics");
assert(panel.includes("TwitterCollectionStatus"), "X empty responses must expose collection diagnostics");
assert(!panel.includes("fallbackSummary={aiSummary}"), "source-specific AI must not silently substitute a generic summary");
assert(socialTypes.includes("telegramCollector?:"), "Telegram collector status must be typed and visible to UI");
assert(socialTypes.includes('lookback: "168"'), "default social backtest window must be at least 7 days");
assert(socialTypes.includes("xExcludeSuspicious: false"), "suspicious X evidence must be flagged, not silently hidden by default");

assert(dockerfile.includes("chromium ca-certificates fonts-liberation"), "frontend runtime must contain Chromium");
assert(compose.includes("./data/x-auth:/app/data/x-auth:ro"), "X auth storage must be mounted into frontend runtime");
assert(compose.includes("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"), "system Chromium path must be provided to Playwright");
assert(compose.includes("TG_PUBLIC_WEB_ENABLED: ${TG_PUBLIC_WEB_ENABLED:-true}"), "Telegram public-web fallback must be enabled by default");
assert(compose.includes("TG_SESSION_STRING: ${TG_SESSION_STRING:-}"), "Telegram session must be forwarded to backend");
assert(compose.includes("TG_MONITOR_CHANNELS: ${TG_MONITOR_CHANNELS:-}"), "Telegram monitor channels must be forwarded to backend");

assert(scraper.includes("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"), "Twitter scraper must use system Chromium when configured");
assert(scraper.includes("Playwright failed; falling back to Nitter"), "auto X strategy must have browser-to-Nitter fallback");
assert(scraper.indexOf("hasTwitterAuth(authPath)") < scraper.indexOf("collectTweetsViaNitter(query, boundedLimit)", scraper.indexOf('if (strategy === "auto")')), "authenticated auto strategy must prefer Playwright");

if (telegramRuntime) {
  assert(
    telegramRuntime.includes("_database_public_channel_seeds"),
    "Telegram collector must bootstrap from known DB channels after restart",
  );
}
assert(healthRoute.includes("/api/v1/telegram/monitor/status"), "source health must report Telegram collector status");
assert(healthRoute.includes("/api/telegram-ai/status"), "source health must report real AI inference status");
assert(healthRoute.includes("authSessionPresent"), "source health must report X auth availability");
assert(healthRoute.includes("chromiumPresent"), "source health must report Chromium availability");

console.log("[social-ai-regression] OK: source loading, X runtime, Telegram collector and AI health invariants are guarded");
