from __future__ import annotations

from app.core.config import Settings
from app.core.twitter_settings_compat import install_x_api_settings_compat


def test_x_api_settings_compat_reads_optional_environment(monkeypatch):
    monkeypatch.setenv("X_API_BEARER_TOKEN", "unit-test-x-token")
    monkeypatch.setenv("X_API_BASE_URL", "https://example.invalid/2/")

    install_x_api_settings_compat()
    settings = Settings.model_construct()

    assert settings.x_api_bearer_token == "unit-test-x-token"
    assert settings.x_api_base_url == "https://example.invalid/2"


def test_x_api_settings_compat_defaults_to_public_api(monkeypatch):
    monkeypatch.delenv("X_API_BEARER_TOKEN", raising=False)
    monkeypatch.delenv("X_API_BASE_URL", raising=False)

    install_x_api_settings_compat()
    settings = Settings.model_construct()

    assert settings.x_api_bearer_token == ""
    assert settings.x_api_base_url == "https://api.x.com/2"
