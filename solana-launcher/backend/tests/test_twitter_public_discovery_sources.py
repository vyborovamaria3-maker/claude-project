import pytest

from app.services.twitter_public_discovery_sources import (
    _handle_from_url,
    _validate_cmc_payload,
)


def test_handle_from_url_accepts_profiles_and_rejects_reserved_paths():
    assert _handle_from_url("https://x.com/Alpha_Caller") == "alpha_caller"
    assert _handle_from_url("https://www.twitter.com/CoinDesk/status/123") == "coindesk"
    assert _handle_from_url("https://x.com/home") is None
    assert _handle_from_url("https://x.com/not-a-handle") is None


def test_cmc_payload_raises_on_application_error():
    with pytest.raises(ValueError, match="CoinMarketCap error 1001"):
        _validate_cmc_payload(
            {
                "status": {
                    "error_code": 1001,
                    "error_message": "invalid request",
                },
                "data": None,
            }
        )


def test_cmc_payload_accepts_success_status():
    payload = {"status": {"error_code": 0}, "data": []}
    assert _validate_cmc_payload(payload) is payload
