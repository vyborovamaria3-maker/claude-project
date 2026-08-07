from app.services.social_intelligence import score_channel_metrics
from app.services.telegram_parser import extract_solana_addresses, is_solana_address, parse_telegram_message

ADDR = "3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump"


def test_solana_address_parser() -> None:
    assert is_solana_address(ADDR)
    assert extract_solana_addresses(f"CA: {ADDR}") == [ADDR]


def test_telegram_parser_extracts_cross_platform_links_and_call() -> None:
    parsed = parse_telegram_message(
        f"100x gem $TEST CA {ADDR} mirror https://t.me/rqcrypt and https://x.com/solana"
    )
    assert parsed.addresses == [ADDR]
    assert parsed.tickers == ["TEST"]
    assert "rqcrypt" in parsed.telegram_usernames
    assert parsed.x_usernames == ["solana"]
    assert parsed.explicit_call is True


def test_score_penalizes_rugs() -> None:
    clean = score_channel_metrics(calls=20, evaluated=10, wins=8, rugs=0, early=10, avg_roi=5.0)
    risky = score_channel_metrics(calls=20, evaluated=10, wins=8, rugs=5, early=10, avg_roi=5.0)
    assert clean > risky
    assert 0 <= risky <= 100
