from pathlib import Path
import json

ROOT = Path("solana-launcher")


def replace(path: Path, old: str, new: str, count: int = 1) -> None:
    text = path.read_text()
    actual = text.count(old)
    if actual < count:
        raise SystemExit(f"{path}: expected at least {count} occurrence(s), found {actual}: {old[:100]!r}")
    path.write_text(text.replace(old, new, count))


# package.json: Next 16 security patch, real ESLint CLI, remove unused runtime compiler,
# keep vulnerable xlsx out of production runtime dependencies.
package_path = ROOT / "package.json"
package = json.loads(package_path.read_text())
package["scripts"]["lint"] = "eslint ."
package["dependencies"]["next"] = "^16.2.11"
package["dependencies"].pop("@lingo.dev/compiler", None)
xlsx = package["dependencies"].pop("xlsx", "^0.18.5")
package["devDependencies"]["xlsx"] = xlsx
package["devDependencies"]["eslint"] = "^10.8.0"
package["devDependencies"]["eslint-config-next"] = "^16.2.10"
package_path.write_text(json.dumps(package, indent=2, ensure_ascii=False) + "\n")

# X scraper metric parser: comma without K/M/B is a thousands separator, not decimal.
scraper = ROOT / "lib/trade/twitter-scraper.ts"
replace(
    scraper,
    '''        const cleaned = text.replace(/,/g, ".").trim();
        const match = cleaned.match(/([0-9]+(?:\\.[0-9]+)?)([KMBКМБ]?)/i);
        if (!match) return 0;
        const value = Number(match[1]);
        const suffix = match[2]?.toUpperCase();''',
    '''        const cleaned = text.replace(/\\s+/g, "").trim();
        const match = cleaned.match(/([0-9]+(?:[.,][0-9]+)?)([KMBКМБ]?)/i);
        if (!match) return 0;
        const suffix = match[2]?.toUpperCase();
        const numeric = suffix ? match[1].replace(",", ".") : match[1].replace(/[.,]/g, "");
        const value = Number(numeric);''',
)

# Standalone X research script: same metric fix + never fabricate tweet/account time.
script = ROOT / "scripts/analyze-twitter-manipulation.mjs"
replace(
    script,
    '''        const cleaned = text.replace(/,/g, ".").trim();
        const match = cleaned.match(/([0-9]+(?:\\.[0-9]+)?)([KMBКМБ]?)/i);
        if (!match) return 0;
        const value = Number(match[1]);
        const suffix = match[2]?.toUpperCase();''',
    '''        const cleaned = text.replace(/\\s+/g, "").trim();
        const match = cleaned.match(/([0-9]+(?:[.,][0-9]+)?)([KMBКМБ]?)/i);
        if (!match) return 0;
        const suffix = match[2]?.toUpperCase();
        const numeric = suffix ? match[1].replace(",", ".") : match[1].replace(/[.,]/g, "");
        const value = Number(numeric);''',
)
replace(
    script,
    '''    account.firstTweetedAt = Math.min(account.firstTweetedAt || Infinity, tweet.postedAt || Date.now());
    account.lastTweetedAt = Math.max(account.lastTweetedAt || 0, tweet.postedAt || Date.now());''',
    '''    if (tweet.postedAt != null) {
      account.firstTweetedAt = Math.min(account.firstTweetedAt ?? Infinity, tweet.postedAt);
      account.lastTweetedAt = Math.max(account.lastTweetedAt ?? 0, tweet.postedAt);
    }''',
)

# X API: real Solana validation, verified-only cannot use Nitter, explicit ticker wins,
# preserve unknown timestamps, and persist the same filtered dataset the UI sees.
route = ROOT / "app/api/trade/dev-twitter/route.ts"
replace(
    route,
    '''import { NextRequest, NextResponse } from "next/server";
import { scrapeTwitter, fetchTokenMeta, buildQuery, normalizeTwitterHandle, type CollectionStrategy } from "../../../../lib/trade/twitter-scraper";''',
    '''import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { scrapeTwitter, fetchTokenMeta, buildQuery, hasTwitterAuth, normalizeTwitterHandle, type CollectionStrategy } from "../../../../lib/trade/twitter-scraper";''',
)
replace(route, "  timestamp: number;\n", "  timestamp: number | null;\n")
replace(
    route,
    '''function persistTwitterStats(stats: TwitterStats, query: string, rawResult: Awaited<ReturnType<typeof scrapeTwitter>>) {''',
    '''type TwitterScrapeResult = Awaited<ReturnType<typeof scrapeTwitter>>;

function persistTwitterStats(
  stats: TwitterStats,
  query: string,
  tweets: TwitterScrapeResult["tweets"],
  accounts: TwitterScrapeResult["accounts"],
) {''',
)
replace(route, "    for (const tweet of rawResult.tweets) {", "    for (const tweet of tweets) {")
replace(route, "    for (const account of rawResult.accounts.values()) {", "    for (const account of accounts.values()) {")
replace(
    route,
    '''function parseBoolean(value: string | null, fallback = false): boolean {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
''',
    '''function parseBoolean(value: string | null, fallback = false): boolean {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function isSolanaMint(value: string): boolean {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}
''',
)
replace(
    route,
    '''  if (!mint) return NextResponse.json({ error: "mint required" }, { status: 400 });
  if (!["nitter", "playwright", "auto"].includes(strategyParam)) {''',
    '''  if (!mint) return NextResponse.json({ error: "mint required" }, { status: 400 });
  if (!isSolanaMint(mint)) return NextResponse.json({ error: "invalid Solana mint" }, { status: 400 });
  if (!["nitter", "playwright", "auto"].includes(strategyParam)) {''',
)
replace(
    route,
    '''  const strategy = strategyParam as CollectionStrategy;
  const scope = scopeParam as "mentions" | "official";''',
    '''  const requestedStrategy = strategyParam as CollectionStrategy;
  if (verifiedOnly && requestedStrategy === "nitter") {
    return NextResponse.json({ error: "verifiedOnly requires Playwright/X browser session; Nitter does not expose verification reliably" }, { status: 400 });
  }
  if (verifiedOnly && !hasTwitterAuth()) {
    return NextResponse.json({ error: "verifiedOnly requires an authenticated X browser session" }, { status: 409 });
  }
  const strategy: CollectionStrategy = verifiedOnly && requestedStrategy === "auto" ? "playwright" : requestedStrategy;
  const scope = scopeParam as "mentions" | "official";''',
)
replace(route, "  const symbol = meta?.symbol || symbolParam || mint.slice(0, 6);", "  const symbol = symbolParam || meta?.symbol || mint.slice(0, 6);")
replace(route, "      timestamp: tweet.postedAt || Date.now(),", "      timestamp: tweet.postedAt,")
replace(
    route,
    '''  const authorAggregates = new Map<string, { tweets: number; engagement: number }>();
  for (const tweet of filteredTweets) {
    const current = authorAggregates.get(tweet.authorHandle) || { tweets: 0, engagement: 0 };
    current.tweets += 1;
    current.engagement += tweetEngagement(tweet);
    authorAggregates.set(tweet.authorHandle, current);
  }
''',
    '''  const authorAggregates = new Map<string, {
    tweets: number;
    engagement: number;
    views: number;
    likes: number;
    retweets: number;
    firstTweetedAt: number | null;
    lastTweetedAt: number | null;
  }>();
  for (const tweet of filteredTweets) {
    const current = authorAggregates.get(tweet.authorHandle) || {
      tweets: 0, engagement: 0, views: 0, likes: 0, retweets: 0, firstTweetedAt: null, lastTweetedAt: null,
    };
    current.tweets += 1;
    current.engagement += tweetEngagement(tweet);
    current.views += tweet.views || 0;
    current.likes += tweet.likes || 0;
    current.retweets += tweet.retweets || 0;
    if (tweet.postedAt != null) {
      current.firstTweetedAt = Math.min(current.firstTweetedAt ?? Infinity, tweet.postedAt);
      current.lastTweetedAt = Math.max(current.lastTweetedAt ?? 0, tweet.postedAt);
    }
    authorAggregates.set(tweet.authorHandle, current);
  }

  const filteredAccounts: TwitterScrapeResult["accounts"] = new Map();
  for (const [handle, aggregate] of authorAggregates) {
    const account = result.accounts.get(handle);
    if (!account) continue;
    filteredAccounts.set(handle, {
      ...account,
      tweetsCount: aggregate.tweets,
      totalViews: aggregate.views,
      totalLikes: aggregate.likes,
      totalRetweets: aggregate.retweets,
      firstTweetedAt: aggregate.firstTweetedAt,
      lastTweetedAt: aggregate.lastTweetedAt,
    });
  }
''',
)
replace(
    route,
    "      const account = result.accounts.get(handle) as (ReturnType<typeof result.accounts.get> & { isBot?: boolean }) | undefined;",
    "      const account = filteredAccounts.get(handle) as (ReturnType<typeof filteredAccounts.get> & { isBot?: boolean }) | undefined;",
    1,
)
replace(
    route,
    "  const botAccounts = Array.from(authorAggregates.keys()).filter((handle) => Boolean((result.accounts.get(handle) as { isBot?: boolean } | undefined)?.isBot));",
    "  const botAccounts = Array.from(authorAggregates.keys()).filter((handle) => Boolean((filteredAccounts.get(handle) as { isBot?: boolean } | undefined)?.isBot));",
)
replace(
    route,
    "  const verifiedAuthors = Array.from(authorAggregates.keys()).filter((handle) => Boolean(result.accounts.get(handle)?.isVerified)).length;",
    "  const verifiedAuthors = Array.from(authorAggregates.keys()).filter((handle) => Boolean(filteredAccounts.get(handle)?.isVerified)).length;",
)
replace(route, "  persistTwitterStats(stats, query, result);", "  persistTwitterStats(stats, query, filteredTweets, filteredAccounts);")

# UI: unknown X timestamps remain unknown instead of becoming "now".
panel = ROOT / "components/trade/SocialIntelligencePanel.tsx"
replace(panel, "  timestamp: number;\n", "  timestamp: number | null;\n")
replace(panel, "        occurred_at: new Date(tweet.timestamp).toISOString(),", "        occurred_at: tweet.timestamp == null ? \"\" : new Date(tweet.timestamp).toISOString(),")
replace(
    panel,
    '''      .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())''',
    '''      .sort((a, b) => {
        const bTime = Date.parse(b.occurred_at);
        const aTime = Date.parse(a.occurred_at);
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
      })''',
)

# Backend: missing X timestamp is not "now"; caller usernames are case-insensitive.
social = ROOT / "backend/app/services/social_intelligence.py"
replace(
    social,
    '''async def top_callers(session: AsyncSession, *, limit: int = 50) -> list[dict[str, Any]]:
    calls = list((await session.execute(select(TelegramCall).where(TelegramCall.caller_username.is_not(None)))).scalars().all())
    grouped: dict[str, list[TelegramCall]] = defaultdict(list)
    for call in calls:
        grouped[call.caller_username or "unknown"].append(call)''',
    '''def normalize_caller_username(value: str | None) -> str:
    return (value or "unknown").strip().lower().lstrip("@") or "unknown"


async def top_callers(session: AsyncSession, *, limit: int = 50) -> list[dict[str, Any]]:
    calls = list((await session.execute(select(TelegramCall).where(TelegramCall.caller_username.is_not(None)))).scalars().all())
    grouped: dict[str, list[TelegramCall]] = defaultdict(list)
    for call in calls:
        grouped[normalize_caller_username(call.caller_username)].append(call)''',
)
replace(
    social,
    '''    inserted = 0
    updated = 0
    for tweet in tweets:''',
    '''    inserted = 0
    updated = 0
    skipped_missing_timestamp = 0
    for tweet in tweets:''',
)
replace(
    social,
    '''        if isinstance(posted_at_raw, (int, float)):
            seconds = posted_at_raw / 1000 if posted_at_raw > 10_000_000_000 else posted_at_raw
            occurred_at = datetime.fromtimestamp(seconds, tz=timezone.utc)
        else:
            occurred_at = _utcnow()''',
    '''        if isinstance(posted_at_raw, (int, float)):
            seconds = posted_at_raw / 1000 if posted_at_raw > 10_000_000_000 else posted_at_raw
            occurred_at = datetime.fromtimestamp(seconds, tz=timezone.utc)
        else:
            skipped_missing_timestamp += 1
            continue''',
)
replace(social, '    return {"inserted": inserted, "updated": updated}\n', '    return {"inserted": inserted, "updated": updated, "skipped_missing_timestamp": skipped_missing_timestamp}\n', 1)

# Backend regression test for caller normalization.
tests = ROOT / "backend/tests/test_telegram_intelligence.py"
replace(tests, "from app.services.social_intelligence import score_channel_metrics", "from app.services.social_intelligence import normalize_caller_username, score_channel_metrics")
tests.write_text(tests.read_text() + '''

def test_caller_username_normalization() -> None:
    assert normalize_caller_username("@AlphaCalls") == "alphacalls"
    assert normalize_caller_username("alphacalls") == "alphacalls"
    assert normalize_caller_username("  ALPHACALLS  ") == "alphacalls"
''')

# Mobile regression must include the Social Analysis screen.
mobile = ROOT / "tests/mobile-regression.mjs"
replace(mobile, '  "/trade/analysis",\n  "/market-overview",', '  "/trade/analysis",\n  "/trade/analysis/social",\n  "/market-overview",')

# Next 16 ESLint flat config.
(ROOT / "eslint.config.mjs").write_text('''import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "test-results/**",
    "data/**",
  ]),
]);
''')

Path(".github/backtest-fixes-applied").write_text("applied\n")
