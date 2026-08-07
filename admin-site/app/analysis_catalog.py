from __future__ import annotations

from typing import Any

DOMAINS = {"wallet", "token", "telegram", "x"}
VALUE_TYPES = {"number", "percent", "currency", "duration", "boolean", "score", "text", "timestamp"}
RUNTIME_STATES = {"active", "available", "legacy"}


def metric(
    domain: str,
    key: str,
    label: str,
    source: str,
    value_type: str,
    *,
    threshold: str = "",
    state: str = "available",
    enabled: bool = False,
    scale: str = "raw",
    description: str = "",
    project_ref: str = "",
) -> dict[str, Any]:
    if domain not in DOMAINS:
        raise ValueError(f"Unknown domain: {domain}")
    if value_type not in VALUE_TYPES:
        raise ValueError(f"Unknown value type: {value_type}")
    if state not in RUNTIME_STATES:
        raise ValueError(f"Unknown runtime state: {state}")
    return {
        "domain": domain,
        "key": key,
        "label": label,
        "source": source,
        "type": value_type,
        "threshold": threshold,
        "runtime_state": state,
        "default_enabled": bool(enabled and state != "legacy"),
        "scale": scale,
        "description": description,
        "project_ref": project_ref,
        "custom": False,
    }


CATALOG: tuple[dict[str, Any], ...] = (
    # Wallet / creator — current dev.ts + dev-wallet + dev-forensics + analytics backend.
    metric("wallet", "total_tokens_created", "Создано токенов", "totalTokensCreated", "number", state="active", enabled=True, description="Количество токенов creator.", project_ref="lib/trade/dev.ts"),
    metric("wallet", "migrated_count", "Migrated tokens", "migratedCount", "number", state="active", enabled=True, project_ref="lib/trade/dev.ts"),
    metric("wallet", "migration_rate", "Migration rate", "migrationRate", "percent", threshold=">= 20%", state="active", enabled=True, scale="ratio", project_ref="lib/trade/dev.ts"),
    metric("wallet", "reached_300k_count", "Tokens >= $300K", "reached300kCount", "number", state="active", enabled=True, project_ref="lib/trade/dev.ts"),
    metric("wallet", "rate_300k", "Rate >= $300K", "rate300k", "percent", threshold=">= 15%", state="active", enabled=True, scale="ratio", project_ref="lib/trade/dev.ts"),
    metric("wallet", "risk_score", "Dev risk score", "riskScore", "score", threshold="<= 55", state="active", enabled=True, project_ref="lib/trade/dev.ts"),
    metric("wallet", "risk_level", "Dev risk level", "riskLevel", "text", state="active", project_ref="lib/trade/dev.ts"),
    metric("wallet", "rug_rate", "Rug rate", "rugRate", "percent", threshold="<= 35%", state="active", enabled=True, scale="ratio", project_ref="lib/trade/dev.ts"),
    metric("wallet", "success_rate", "Success rate", "successRate", "percent", threshold=">= 15%", state="active", enabled=True, scale="ratio", project_ref="lib/trade/dev.ts"),
    metric("wallet", "avg_mc_usd", "Average market cap", "avgMcUsd", "currency", state="active", project_ref="lib/trade/dev.ts"),
    metric("wallet", "median_mc_usd", "Median market cap", "medianMcUsd", "currency", state="active", project_ref="lib/trade/dev.ts"),
    metric("wallet", "max_mc_usd", "Maximum market cap", "maxMcUsd", "currency", state="active", project_ref="lib/trade/dev.ts"),
    metric("wallet", "min_launch_interval", "Min time between launches", "minTimeBetweenLaunchesSec", "duration", state="active", scale="seconds", project_ref="lib/trade/dev.ts"),
    metric("wallet", "avg_launch_interval", "Avg time between launches", "avgTimeBetweenLaunchesSec", "duration", state="active", scale="seconds", project_ref="lib/trade/dev.ts"),
    metric("wallet", "days_since_last_launch", "Days since last launch", "daysSinceLastLaunch", "duration", state="active", scale="days", project_ref="lib/trade/dev.ts"),
    metric("wallet", "best_launch_hour", "Best launch hour UTC", "bestLaunchHourUtc", "number", state="active", project_ref="lib/trade/dev.ts"),
    metric("wallet", "total_volume_sol", "Total volume SOL", "totalVolumeSol", "number", state="available", project_ref="api/trade/dev-wallet/route.ts"),
    metric("wallet", "total_fees_sol", "Total fees SOL", "totalFeesSol", "number", state="available", project_ref="api/trade/dev-wallet/route.ts"),
    metric("wallet", "first_seen_at", "First seen", "firstSeenAt", "timestamp", state="available", project_ref="api/trade/dev-wallet/route.ts"),
    metric("wallet", "profit_total", "Realized profit total", "profit_total", "currency", state="available", project_ref="backend/schemas/analytics.py"),
    metric("wallet", "wallet_token_count", "Wallet token count", "token_count", "number", state="available", project_ref="backend/schemas/analytics.py"),
    metric("wallet", "realized_profit_usd", "Trade realized profit", "trades.realized_profit_usd", "currency", state="available", project_ref="backend/models/analytics.py"),
    metric("wallet", "still_holding", "Still holding", "trades.still_holding", "boolean", state="available", project_ref="backend/models/analytics.py"),
    metric("wallet", "shared_tokens_count", "Shared tokens", "links.shared_tokens_count", "number", state="available", project_ref="backend/models/analytics.py"),
    metric("wallet", "similarity_score", "Wallet similarity", "links.similarity_score", "score", state="available", project_ref="backend/models/analytics.py"),
    metric("wallet", "forensics_total_created", "Forensics total created", "totalCreatedTokens", "number", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("wallet", "forensics_total_migrated", "Forensics total migrated", "totalMigratedTokens", "number", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("wallet", "forensics_migration_rate", "Forensics migration rate", "migrationRate", "percent", state="available", scale="percent100", project_ref="api/trade/dev-forensics/route.ts"),
    metric("wallet", "avg_lifespan_hours", "Average lifespan", "avgLifespanHours", "duration", state="available", scale="hours", project_ref="api/trade/dev-forensics/route.ts"),
    metric("wallet", "median_lifespan_hours", "Median lifespan", "medianLifespanHours", "duration", state="available", scale="hours", project_ref="api/trade/dev-forensics/route.ts"),
    metric("wallet", "average_token_volume_usd", "Average token volume", "averageTokenVolumeUsd", "currency", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("wallet", "average_creator_fees_usd", "Average creator fees", "averageCreatorFeesUsd", "currency", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("wallet", "resolved_volume_total", "Resolved token volume total", "resolvedTokenVolumeUsdTotal", "currency", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("wallet", "resolved_fees_total", "Resolved creator fees total", "resolvedCreatorFeesUsdTotal", "currency", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("wallet", "current_network_volume", "Current network volume", "currentNetworkVolumeM", "currency", state="available", scale="millions", project_ref="api/trade/dev-forensics/route.ts"),
    metric("wallet", "optimal_launch_time", "Optimal launch time", "isOptimalLaunchTime", "boolean", threshold="true", state="available", project_ref="api/trade/dev-forensics/route.ts"),

    # Token — current dev token/forensics plus backend TokenMetric fields.
    metric("token", "market_cap_usd", "Market cap", "marketCapUsd", "currency", state="active", enabled=True, project_ref="lib/trade/dev.ts"),
    metric("token", "ath_usd", "ATH", "athUsd", "currency", state="active", enabled=True, project_ref="lib/trade/dev.ts"),
    metric("token", "is_migrated", "Migrated", "isMigrated", "boolean", threshold="true", state="active", project_ref="lib/trade/dev.ts"),
    metric("token", "reached_300k", "Reached $300K", "reached300k", "boolean", state="active", project_ref="lib/trade/dev.ts"),
    metric("token", "created_at", "Created at", "createdAt", "timestamp", state="active", project_ref="lib/trade/dev.ts"),
    metric("token", "lifespan_hours", "Lifespan hours", "lifespanHours", "duration", state="available", scale="hours", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "network_volume_launch", "Network volume at launch", "networkVolumeMAt_launch", "currency", state="available", scale="millions", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "pumpfun_volume_launch", "Pump.fun volume at launch", "pumpFunVolumeMAt_launch", "currency", state="available", scale="millions", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "token_volume_sol", "Token volume SOL", "tokenVolumeSol", "number", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "token_volume_usd", "Token volume USD", "tokenVolumeUsd", "currency", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "peak_market_cap", "Peak market cap", "peakMarketCap", "currency", threshold=">= $100k", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "historical_peak_mcap", "Historical peak MCAP", "historicalPeakMCAP", "currency", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "creator_fees_usd", "Creator fees", "creatorFeesUsd", "currency", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "total_fees_sol", "Total fees SOL", "totalFeesSol", "number", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "total_fees_usd", "Total fees USD", "totalFeesUsd", "currency", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "migration_market_cap", "Migration market cap", "migrationMarketCap", "currency", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "migration_timestamp", "Migration time", "migrationTimestamp", "timestamp", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "price_usd", "Price USD", "latest_metric.price_usd", "currency", state="available", project_ref="backend/models/analytics.py"),
    metric("token", "metric_ath_usd", "Metric ATH USD", "latest_metric.ath_usd", "currency", state="available", project_ref="backend/models/analytics.py"),
    metric("token", "fdv", "FDV", "latest_metric.fdv", "currency", state="available", project_ref="backend/models/analytics.py"),
    metric("token", "liquidity_usd", "Liquidity", "latest_metric.liquidity_usd", "currency", state="available", project_ref="backend/models/analytics.py"),
    metric("token", "volume_24h", "24h volume", "latest_metric.volume_24h", "currency", state="available", project_ref="backend/models/analytics.py"),
    metric("token", "tx_count_24h", "24h transactions", "latest_metric.tx_count_24h", "number", state="available", project_ref="backend/models/analytics.py"),
    metric("token", "holder_count", "Holders", "latest_metric.holder_count", "number", state="available", project_ref="backend/models/analytics.py"),
    metric("token", "social_engagements", "Social engagements", "latest_metric.social_engagements", "number", state="available", project_ref="backend/models/analytics.py"),
    metric("token", "status", "Token status", "status", "text", state="available", project_ref="backend/models/analytics.py"),
    metric("token", "migrated_to_raydium", "Migrated to Raydium", "migrated_to_raydium", "boolean", state="available", project_ref="backend/models/analytics.py"),
    metric("token", "twitter_followers", "X followers", "twitter.followers", "number", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "twitter_posts", "X posts", "twitter.postsCount", "number", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "twitter_avg_views", "X avg views", "twitter.avgViews", "number", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "twitter_avg_likes", "X avg likes", "twitter.avgLikes", "number", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "twitter_avg_retweets", "X avg retweets", "twitter.avgRetweets", "number", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "twitter_bot_score", "X bot score", "twitter.botScore", "score", threshold="<= 35", state="available", project_ref="api/trade/dev-forensics/route.ts"),
    metric("token", "solscan_holder_count", "Solscan holder count", "holderCount", "number", state="legacy", project_ref="api/trade/dev-forensics/route.ts"),

    # Telegram — database fields and exact scoring components in social_intelligence.py.
    metric("telegram", "participants", "Participants", "participants", "number", state="available", project_ref="backend/models/social_intelligence.py"),
    metric("telegram", "calls_count", "Calls", "calls_count", "number", state="active", enabled=True, project_ref="backend/services/social_intelligence.py"),
    metric("telegram", "evaluated_calls", "Evaluated calls", "evaluated_calls", "number", state="active", enabled=True, project_ref="backend/models/social_intelligence.py"),
    metric("telegram", "successful_calls", "Successful calls", "successful_calls", "number", state="active", project_ref="backend/models/social_intelligence.py"),
    metric("telegram", "rug_calls", "Rug calls", "rug_calls", "number", state="active", project_ref="backend/models/social_intelligence.py"),
    metric("telegram", "early_calls", "Early calls", "early_calls", "number", state="active", project_ref="backend/models/social_intelligence.py"),
    metric("telegram", "win_rate", "Win rate", "win_rate", "percent", threshold=">= 50%", state="active", enabled=True, scale="ratio", project_ref="backend/services/social_intelligence.py"),
    metric("telegram", "rug_rate", "Rug rate", "rug_rate", "percent", threshold="<= 15%", state="active", enabled=True, scale="ratio", project_ref="backend/services/social_intelligence.py"),
    metric("telegram", "avg_roi", "Average ROI multiple", "avg_roi", "number", threshold=">= 2", state="active", enabled=True, project_ref="backend/services/social_intelligence.py"),
    metric("telegram", "channel_score", "Channel score", "score", "score", threshold=">= 60", state="active", enabled=True, project_ref="backend/services/social_intelligence.py"),
    metric("telegram", "confidence", "Score confidence", "derived.confidence", "percent", state="active", scale="ratio", project_ref="backend/services/social_intelligence.py"),
    metric("telegram", "early_rate", "Early-call rate", "derived.early_rate", "percent", state="active", scale="ratio", project_ref="backend/services/social_intelligence.py"),
    metric("telegram", "roi_component", "ROI score component", "derived.roi_component", "percent", state="active", scale="ratio", project_ref="backend/services/social_intelligence.py"),
    metric("telegram", "message_views", "Message views", "message.views", "number", state="available", project_ref="backend/models/social_intelligence.py"),
    metric("telegram", "message_forwards", "Message forwards", "message.forwards", "number", state="available", project_ref="backend/models/social_intelligence.py"),
    metric("telegram", "message_replies", "Message replies", "message.replies", "number", state="available", project_ref="backend/models/social_intelligence.py"),
    metric("telegram", "message_reactions", "Message reactions", "message.reactions", "number", state="available", project_ref="backend/models/social_intelligence.py"),
    metric("telegram", "explicit_call", "Explicit call", "is_explicit_call", "boolean", state="available", project_ref="backend/models/social_intelligence.py"),
    metric("telegram", "call_market_cap", "Call market cap", "call_market_cap_usd", "currency", state="available", project_ref="backend/models/social_intelligence.py"),
    metric("telegram", "peak_market_cap", "Peak market cap", "peak_market_cap_usd", "currency", state="available", project_ref="backend/models/social_intelligence.py"),
    metric("telegram", "roi_multiple", "Call ROI multiple", "roi_multiple", "number", state="available", project_ref="backend/models/social_intelligence.py"),
    metric("telegram", "outcome", "Call outcome", "outcome", "text", state="available", project_ref="backend/models/social_intelligence.py"),
    metric("telegram", "timeline_mentions", "Timeline mentions", "mentions", "number", state="available", project_ref="backend/services/social_intelligence.py"),

    # X / Twitter — dev-twitter output + persisted analysis/account/shiller fields.
    metric("x", "total_tweets", "Tweets / mentions", "totalTweets", "number", state="active", enabled=True, project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "total_views", "Total views", "totalViews", "number", state="active", enabled=True, project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "total_likes", "Total likes", "totalLikes", "number", state="active", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "total_retweets", "Total retweets", "totalRetweets", "number", state="active", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "unique_mentioners", "Unique mentioners", "uniqueMentioners", "number", state="active", enabled=True, project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "bot_risk", "Bot risk level", "botRisk", "text", state="active", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "bot_risk_score", "Bot risk score", "botRiskScore", "score", threshold="<= 35", state="active", enabled=True, project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "anomaly_count", "Anomaly count", "anomalyCount", "number", threshold="<= 3", state="active", enabled=True, project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "avg_views", "Average views", "avgViews", "number", state="active", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "avg_likes", "Average likes", "avgLikes", "number", state="active", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "avg_retweets", "Average retweets", "avgRetweets", "number", state="active", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "total_engagement", "Total engagement", "aggregated.totalEngagement", "number", state="active", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "engagement_rate", "Engagement rate", "aggregated.engagementRate", "percent", state="active", scale="ratio", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "unique_authors", "Unique authors", "aggregated.uniqueAuthors", "number", state="active", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "verified_authors", "Verified authors", "aggregated.verifiedAuthors", "number", state="active", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "bot_suspected_count", "Bot suspected count", "aggregated.botSuspectedCount", "number", state="active", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "bot_ratio", "Bot ratio", "aggregated.botRatio", "percent", threshold="<= 25%", state="active", enabled=True, scale="ratio", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "token_followers", "Official account followers", "tokenAccount.followers", "number", state="available", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "token_posts", "Official account posts", "tokenAccount.postsCount", "number", state="available", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "token_verified", "Official account verified", "tokenAccount.isVerified", "boolean", state="available", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "discovery_mentions", "Discovery mentions", "discovery.mentions", "number", state="available", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "discovery_accounts", "Discovery accounts", "discovery.accounts", "number", state="available", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "discovery_memecoin_accounts", "Discovery memecoin accounts", "discovery.memecoinAccounts", "number", state="available", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "first_account_created_at", "First discovered account", "discovery.firstAccountCreatedAt", "timestamp", state="available", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "last_discovered_at", "Last discovered", "discovery.lastDiscoveredAt", "timestamp", state="available", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "response_time_ms", "Collection response time", "performance.responseTimeMs", "duration", scale="milliseconds", state="available", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "collection_cached", "Collection cached", "performance.cached", "boolean", state="available", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "shiller_tweets", "Shiller tweets", "shillers.tweets", "number", state="available", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "shiller_engagement", "Shiller engagement", "shillers.totalEngagement", "number", state="available", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "shiller_bot", "Shiller bot", "shillers.isBot", "boolean", state="available", project_ref="api/trade/dev-twitter/route.ts"),
    metric("x", "account_following", "Account following", "twitter_accounts.following", "number", state="legacy", project_ref="lib/trade/db.ts"),
    metric("x", "subscription_promoter", "Subscription promoter", "twitter_accounts.is_subscription_promoter", "boolean", state="legacy", project_ref="lib/trade/db.ts"),
    metric("x", "excluded_bot_accounts", "Excluded bot accounts", "twitter_token_analyses.excluded_bot_accounts", "number", state="legacy", project_ref="api/trade/dev-twitter/route.ts"),
)

CATALOG_BY_ID = {(row["domain"], row["key"]): row for row in CATALOG}


def catalog_for(domain: str | None = None) -> list[dict[str, Any]]:
    rows = [dict(row) for row in CATALOG if domain is None or row["domain"] == domain]
    rows.sort(key=lambda row: (row["domain"], row["runtime_state"] == "legacy", row["label"].lower()))
    return rows
