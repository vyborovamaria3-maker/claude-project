from pathlib import Path
import json

ROOT = Path("solana-launcher")


def replace(path: Path, old: str, new: str, count: int = 1) -> None:
    text = path.read_text()
    actual = text.count(old)
    if actual < count:
        raise SystemExit(f"{path}: expected at least {count} occurrence(s), found {actual}: {old[:120]!r}")
    path.write_text(text.replace(old, new, count))


# ESLint 10 is currently incompatible with the react plugin pulled by this Next config.
package_path = ROOT / "package.json"
package = json.loads(package_path.read_text())
package["devDependencies"]["eslint"] = "^9.39.5"
package_path.write_text(json.dumps(package, indent=2, ensure_ascii=False) + "\n")

# X query inputs: avoid accidental/hostile X search operators via ticker or handle.
route = ROOT / "app/api/trade/dev-twitter/route.ts"
replace(
    route,
    '  const symbolParam = req.nextUrl.searchParams.get("symbol") || "";',
    '  const symbolParam = (req.nextUrl.searchParams.get("symbol") || "").trim().replace(/^\\$/, "");',
)
replace(
    route,
    '''  if (!["mentions", "official"].includes(scopeParam)) {
    return NextResponse.json({ error: "scope must be one of: mentions, official" }, { status: 400 });
  }

  const requestedStrategy = strategyParam as CollectionStrategy;''',
    '''  if (!["mentions", "official"].includes(scopeParam)) {
    return NextResponse.json({ error: "scope must be one of: mentions, official" }, { status: 400 });
  }
  if (symbolParam && !/^[A-Za-z0-9_]{1,32}$/.test(symbolParam)) {
    return NextResponse.json({ error: "symbol contains unsupported characters" }, { status: 400 });
  }
  if (providedHandle && !/^[A-Za-z0-9_]{1,30}$/.test(providedHandle)) {
    return NextResponse.json({ error: "invalid X handle" }, { status: 400 });
  }

  const requestedStrategy = strategyParam as CollectionStrategy;''',
)

# Browser-persisted parameters are untrusted JSON; validate enums/booleans before reusing them.
panel = ROOT / "components/trade/SocialIntelligencePanel.tsx"
replace(
    panel,
    '''function normalizeOptions(value: Partial<AnalysisOptions>): AnalysisOptions {
  return {
    ...DEFAULT_OPTIONS,
    ...value,
    symbol: String(value.symbol ?? DEFAULT_OPTIONS.symbol),
    twitterHandle: String(value.twitterHandle ?? DEFAULT_OPTIONS.twitterHandle),
    tgSources: String(value.tgSources ?? DEFAULT_OPTIONS.tgSources),
    xLimit: Math.max(5, Math.min(100, Number(value.xLimit ?? DEFAULT_OPTIONS.xLimit) || DEFAULT_OPTIONS.xLimit)),
    xMinEngagement: Math.max(0, Number(value.xMinEngagement ?? DEFAULT_OPTIONS.xMinEngagement) || 0),
    tgLimit: Math.max(1, Math.min(1000, Number(value.tgLimit ?? DEFAULT_OPTIONS.tgLimit) || DEFAULT_OPTIONS.tgLimit)),
    tgMinEngagement: Math.max(0, Number(value.tgMinEngagement ?? DEFAULT_OPTIONS.tgMinEngagement) || 0),
    tgMinChannelScore: Math.max(0, Math.min(100, Number(value.tgMinChannelScore ?? DEFAULT_OPTIONS.tgMinChannelScore) || 0)),
  };
}''',
    '''function normalizeOptions(value: Partial<AnalysisOptions>): AnalysisOptions {
  const lookbackValues: Lookback[] = ["1", "6", "24", "72", "168", "720", "all"];
  const strategyValues: XStrategy[] = ["auto", "nitter", "playwright"];
  const scopeValues: XScope[] = ["mentions", "official"];
  const lookback = lookbackValues.includes(value.lookback as Lookback) ? value.lookback as Lookback : DEFAULT_OPTIONS.lookback;
  const xStrategy = strategyValues.includes(value.xStrategy as XStrategy) ? value.xStrategy as XStrategy : DEFAULT_OPTIONS.xStrategy;
  const xScope = scopeValues.includes(value.xScope as XScope) ? value.xScope as XScope : DEFAULT_OPTIONS.xScope;

  return {
    ...DEFAULT_OPTIONS,
    symbol: String(value.symbol ?? DEFAULT_OPTIONS.symbol),
    twitterHandle: String(value.twitterHandle ?? DEFAULT_OPTIONS.twitterHandle),
    tgSources: String(value.tgSources ?? DEFAULT_OPTIONS.tgSources),
    lookback,
    xStrategy,
    xScope,
    xLimit: Math.max(5, Math.min(100, Number(value.xLimit ?? DEFAULT_OPTIONS.xLimit) || DEFAULT_OPTIONS.xLimit)),
    xMinEngagement: Math.max(0, Number(value.xMinEngagement ?? DEFAULT_OPTIONS.xMinEngagement) || 0),
    xVerifiedOnly: typeof value.xVerifiedOnly === "boolean" ? value.xVerifiedOnly : DEFAULT_OPTIONS.xVerifiedOnly,
    xExcludeSuspicious: typeof value.xExcludeSuspicious === "boolean" ? value.xExcludeSuspicious : DEFAULT_OPTIONS.xExcludeSuspicious,
    tgLimit: Math.max(1, Math.min(1000, Number(value.tgLimit ?? DEFAULT_OPTIONS.tgLimit) || DEFAULT_OPTIONS.tgLimit)),
    tgMinEngagement: Math.max(0, Number(value.tgMinEngagement ?? DEFAULT_OPTIONS.tgMinEngagement) || 0),
    tgMinChannelScore: Math.max(0, Math.min(100, Number(value.tgMinChannelScore ?? DEFAULT_OPTIONS.tgMinChannelScore) || 0)),
    tgExplicitCallsOnly: typeof value.tgExplicitCallsOnly === "boolean" ? value.tgExplicitCallsOnly : DEFAULT_OPTIONS.tgExplicitCallsOnly,
  };
}''',
)

# Telegram source URLs may include message IDs, query strings or fragments.
filters = ROOT / "backend/app/services/social_filters.py"
replace(
    filters,
    '    return normalized.strip("/").split("/", 1)[0]',
    '    return normalized.strip("/").split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]',
)

# Channel-score filtering must cover all channels, not just the first 500.
api = ROOT / "backend/app/api/v1/telegram_intelligence.py"
replace(
    api,
    '''async def _channel_scores(session: AsyncSession) -> dict[str, float]:
    channels, _ = await list_channels(session, limit=500, offset=0)
    result: dict[str, float] = {}
    for item in channels:
        score = float(item.get("score") or 0.0)
        username = str(item.get("username") or "").strip()
        telegram_id = str(item.get("telegram_id") or "").strip()
        if username:
            result[normalize_social_source(username)] = score
        if telegram_id:
            result[normalize_social_source(telegram_id)] = score
    return result''',
    '''async def _channel_scores(session: AsyncSession) -> dict[str, float]:
    result: dict[str, float] = {}
    offset = 0
    while True:
        channels, total = await list_channels(session, limit=500, offset=offset)
        for item in channels:
            score = float(item.get("score") or 0.0)
            username = str(item.get("username") or "").strip()
            telegram_id = str(item.get("telegram_id") or "").strip()
            if username:
                result[normalize_social_source(username)] = score
            if telegram_id:
                result[normalize_social_source(telegram_id)] = score
        offset += len(channels)
        if not channels or offset >= total:
            break
    return result''',
)

# Preserve suspicious status in stored X social events.
social = ROOT / "backend/app/services/social_intelligence.py"
replace(
    social,
    '''            "verified": bool(tweet.get("is_verified")),
            "suspicion_score": tweet.get("suspicion_score"),''',
    '''            "verified": bool(tweet.get("is_verified")),
            "suspicion_score": tweet.get("suspicion_score"),
            "suspicious": float(tweet.get("suspicion_score") or 0) >= 50.0,''',
)

# Migration API limit should never become negative.
migration = ROOT / "app/api/migrations/xlsx/route.ts"
replace(
    migration,
    '  const limit = Number.isFinite(parsedLimit) ? Math.min(parsedLimit, 500) : 100;',
    '  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 500)) : 100;',
)

# Regression coverage for Telegram URL normalization.
tests = ROOT / "backend/tests/test_telegram_intelligence.py"
replace(
    tests,
    '    assert normalize_social_source("https://t.me/Alpha_Calls/12345") == "alpha_calls"',
    '    assert normalize_social_source("https://t.me/Alpha_Calls/12345?single#post") == "alpha_calls"',
)
