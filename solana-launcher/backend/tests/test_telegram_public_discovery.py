import asyncio
from datetime import UTC, datetime

from app.services.telegram_public_discovery import (
    TelegramPublicWebDiscoveryCollector,
    extract_discovered_channels,
    score_memecoin_channel,
)
from app.services.telegram_public_web import PublicTelegramMessage

ADDR_1 = "3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump"
ADDR_2 = "DksAcB4w38E7bfzQ2KbjwG3sf95vUPWX9x7rhniwpump"
NOW = datetime(2026, 8, 31, 8, 0, tzinfo=UTC)


def _message(
    channel: str,
    message_id: int,
    text: str,
    *,
    links: list[str] | None = None,
) -> PublicTelegramMessage:
    return PublicTelegramMessage(
        channel_username=channel,
        message_id=message_id,
        url=f"https://t.me/{channel}/{message_id}",
        published_at=NOW,
        text=text,
        links=links or [],
    )


def _settings():
    class StubSettings:
        telegram_public_web_enabled = True
        telegram_public_web_channels = "seed_calls"
        telegram_monitor_channels = ""
        telegram_public_web_history_limit = 50
        telegram_public_web_timeout_seconds = 5.0
        telegram_public_web_discovery_enabled = True
        telegram_public_web_discovery_depth = 2
        telegram_public_web_discovery_entity_limit = 10
        telegram_public_web_discovery_history_limit = 40
        telegram_public_web_relevance_min_score = 35.0
        telegram_public_web_seed_database = ""
        telegram_public_web_seed_database_limit = 0

    return StubSettings()


def test_discovery_uses_explicit_tme_links_not_plain_mentions() -> None:
    messages = [
        _message(
            "seed_calls",
            1,
            "watch @not_enough_evidence and https://t.me/AlphaCalls/123",
            links=["https://t.me/s/BetaCalls", "https://t.me/seed_calls/1"],
        )
    ]
    assert extract_discovered_channels(messages, source_username="seed_calls") == [
        "alphacalls",
        "betacalls",
    ]


def test_relevance_score_prefers_real_memecoin_call_channels() -> None:
    strong = [
        _message("alpha", 1, f"100x gem CA {ADDR_1} pump.fun entry"),
        _message("alpha", 2, f"new Solana call CA {ADDR_2} launch now"),
        _message("alpha", 3, f"re-entry on {ADDR_1} mcap moving"),
    ]
    weak = [
        _message("news", 1, "Bitcoin macro update and ETF discussion"),
        _message("news", 2, "Market news, no token contract here"),
        _message("news", 3, "General crypto headlines"),
    ]

    strong_score = score_memecoin_channel(strong)
    weak_score = score_memecoin_channel(weak)

    assert strong_score.score >= 35.0
    assert strong_score.token_posts == 3
    assert strong_score.unique_mints == 2
    assert weak_score.token_posts == 0
    assert weak_score.score < 35.0


def test_graph_accepts_relevant_channel_and_filters_noise() -> None:
    collector = TelegramPublicWebDiscoveryCollector(_settings(), None)  # type: ignore[arg-type]
    pages = {
        "seed_calls": [
            _message(
                "seed_calls",
                1,
                f"CA {ADDR_1} call",
                links=["https://t.me/good_calls", "https://t.me/random_news"],
            ),
            _message("seed_calls", 2, f"CA {ADDR_2} pump.fun gem"),
        ],
        "good_calls": [
            _message("good_calls", 10, f"CA {ADDR_1} pump.fun call"),
            _message("good_calls", 11, f"CA {ADDR_2} new Solana entry"),
        ],
        "random_news": [
            _message("random_news", 20, "Macro news and general market commentary"),
            _message("random_news", 21, "No contract addresses in this channel"),
        ],
    }
    persisted: list[str] = []

    async def fake_load(username: str, limit: int):
        return pages[username]

    async def fake_persist(username, messages, *, relevance, discovered_from, discovery_depth):
        persisted.append(username)
        return {
            "platform": "telegram",
            "collector": "public_web",
            "username": username,
            "posts_saved": len(messages),
            "token_mentions_created": relevance.token_posts,
            "memecoin_relevance": relevance.as_dict(),
            "discovered_from": discovered_from,
            "discovery_depth": discovery_depth,
        }

    collector._load_channel = fake_load  # type: ignore[method-assign]
    collector._persist_loaded_channel = fake_persist  # type: ignore[method-assign]

    result = asyncio.run(collector.scan_channels(["seed_calls"], history_limit=50))

    assert persisted == ["seed_calls", "good_calls"]
    assert result["discovery"]["discovered"] == 2
    assert result["discovery"]["accepted"] == 1
    assert result["discovery"]["rejected"] == 1
    assert result["discovery"]["seed_validated"] == 1
    rejected = next(row for row in result["results"] if row.get("filtered"))
    assert rejected["username"] == "random_news"
    assert rejected["reason"] == "memecoin_relevance_below_threshold"


def test_seed_revalidation_is_not_counted_as_graph_discovery() -> None:
    collector = TelegramPublicWebDiscoveryCollector(_settings(), None)  # type: ignore[arg-type]

    async def fake_load(username: str, limit: int):
        return [_message(username, 1, "general macro news with no contract address")]

    collector._load_channel = fake_load  # type: ignore[method-assign]
    result = asyncio.run(
        collector.scan_channels(
            ["historical_seed"],
            history_limit=40,
            force_accept_explicit=False,
        )
    )

    assert result["discovery"]["discovered"] == 0
    assert result["discovery"]["accepted"] == 0
    assert result["discovery"]["rejected"] == 0
    assert result["discovery"]["seed_rejected"] == 1
