import asyncio

import pytest
from app.services.telegram_parser import parse_telegram_message
from app.services.telegram_public_web import (
    TelegramPublicWebCollector,
    TelegramPublicWebError,
    TelegramPublicWebUnavailable,
    parse_metric_count,
    parse_public_telegram_html,
)

ADDR = "3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump"


def _message_html(
    message_id: int, text: str, views: str = "1.2K", extra_link: str | None = None
) -> str:
    link = f'<a href="{extra_link}">source</a>' if extra_link else ""
    return f"""
    <div class="tgme_widget_message_wrap js-widget_message_wrap">
      <div class="tgme_widget_message text_not_supported_wrap js-widget_message"
           data-post="alpha_calls/{message_id}">
        <div class="tgme_widget_message_text js-message_text" dir="auto">{text}<br/>{link}</div>
        <div class="tgme_widget_message_footer compact js-message_footer">
          <span class="tgme_widget_message_views">{views}</span>
          <a class="tgme_widget_message_date" href="https://t.me/alpha_calls/{message_id}">
            <time datetime="2026-08-31T06:30:00+00:00">06:30</time>
          </a>
        </div>
      </div>
    </div>
    """


def _settings(
    *, enabled: bool = True, public_channels: str = "alpha_calls", monitor_channels: str = ""
):
    class StubSettings:
        telegram_public_web_enabled = enabled
        telegram_public_web_channels = public_channels
        telegram_monitor_channels = monitor_channels
        telegram_public_web_history_limit = 100
        telegram_public_web_timeout_seconds = 5.0

    return StubSettings()


def test_public_page_parser_extracts_real_message_fields() -> None:
    html = _message_html(101, f"100x gem $TEST CA {ADDR}", "12.3K", "https://x.com/solana")
    messages = parse_public_telegram_html(html)
    assert len(messages) == 1
    message = messages[0]
    assert message.channel_username == "alpha_calls"
    assert message.message_id == 101
    assert message.url == "https://t.me/alpha_calls/101"
    assert message.published_at is not None
    assert message.views == 12_300
    assert ADDR in message.text
    assert "https://x.com/solana" in message.links
    parsed = parse_telegram_message("\n".join([message.text, *message.links]))
    assert parsed.addresses == [ADDR]
    assert parsed.x_usernames == ["solana"]
    assert parsed.explicit_call is True


def test_public_page_parser_handles_multiple_messages_and_missing_mint() -> None:
    html = _message_html(101, f"CA {ADDR}") + _message_html(102, "No token address here", "50")
    messages = parse_public_telegram_html(html)
    assert [item.message_id for item in messages] == [101, 102]
    assert parse_telegram_message(messages[0].text).addresses == [ADDR]
    assert parse_telegram_message(messages[1].text).addresses == []


def test_public_page_parser_tolerates_malformed_or_private_page_html() -> None:
    assert parse_public_telegram_html("<html><body>Channel unavailable</body></html>") == []
    assert parse_public_telegram_html("<div class='tgme_widget_message'>broken") == []


def test_metric_parser_does_not_invent_missing_values() -> None:
    assert parse_metric_count("1.5K") == 1_500
    assert parse_metric_count("2M") == 2_000_000
    assert parse_metric_count("") is None
    assert parse_metric_count("unknown") is None


def test_public_channel_pagination_deduplicates_message_ids() -> None:
    collector = TelegramPublicWebCollector(_settings(), None)  # type: ignore[arg-type]
    page = _message_html(101, f"CA {ADDR}") + _message_html(102, "No mint")
    calls = 0

    async def fake_fetch(url: str) -> str:
        nonlocal calls
        calls += 1
        return page

    collector._fetch = fake_fetch  # type: ignore[method-assign]
    messages = asyncio.run(collector._load_channel("alpha_calls", 50))
    assert sorted(item.message_id for item in messages) == [101, 102]
    assert calls == 2


def test_private_or_empty_preview_is_unavailable_not_zero_coverage() -> None:
    collector = TelegramPublicWebCollector(_settings(), None)  # type: ignore[arg-type]

    async def fake_fetch(url: str) -> str:
        return "<html><body>Channel unavailable</body></html>"

    collector._fetch = fake_fetch  # type: ignore[method-assign]
    with pytest.raises(TelegramPublicWebUnavailable, match="exposed no messages"):
        asyncio.run(collector._load_channel("alpha_calls", 20))


def test_public_channels_fall_back_to_monitor_channel_list() -> None:
    collector = TelegramPublicWebCollector(
        _settings(
            public_channels="", monitor_channels="@Alpha_Calls, https://t.me/BetaCalls,alpha_calls"
        ),
        None,  # type: ignore[arg-type]
    )
    assert collector.configured_channels == ["alpha_calls", "betacalls"]


def test_disabled_public_web_scan_is_rejected_without_network() -> None:
    collector = TelegramPublicWebCollector(_settings(enabled=False), None)  # type: ignore[arg-type]
    with pytest.raises(TelegramPublicWebUnavailable, match="TG_PUBLIC_WEB_ENABLED"):
        asyncio.run(collector.scan_channels())


def test_empty_public_web_channel_config_is_rejected() -> None:
    collector = TelegramPublicWebCollector(_settings(public_channels="", monitor_channels=""), None)  # type: ignore[arg-type]
    with pytest.raises(TelegramPublicWebUnavailable, match="No public Telegram channels"):
        asyncio.run(collector.scan_channels())


def test_all_failed_public_scan_does_not_claim_successful_coverage() -> None:
    collector = TelegramPublicWebCollector(
        _settings(public_channels="alpha_calls,beta_calls"), None
    )  # type: ignore[arg-type]

    async def fail_channel(username: str, *, history_limit: int | None = None):
        raise TelegramPublicWebError("network error")

    collector.scan_channel = fail_channel  # type: ignore[method-assign]
    result = asyncio.run(collector.scan_channels())
    status = collector.status()
    assert result["successful"] == 0
    assert status["last_scan_at"] is None
    assert status["last_error"] == "network error"
    assert status["last_scan_messages"] == 0
    assert status["last_scan_matches"] == 0
