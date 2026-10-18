"""Offline operator setup tests. No real Bot API requests are made."""

from __future__ import annotations

import base64
import json
from uuid import uuid4

import pytest
from app.cli import configure_tginvite_consent_webhook as setup

PUBLIC_URL = "https://example.org/api/v1/tginvite/consent-webhook"
TOKEN = "123456789:" + "z" * 35


def configure(test_app):
    settings = test_app.state.settings
    settings.tginvite_consent_bot_id = "123456789"
    settings.tginvite_consent_webhook_secret = "setup_secret_token_" + "t" * 32
    settings.tginvite_consent_chat_bindings = json.dumps({
        "-100123456789": str(uuid4()),
    })
    settings.tginvite_consent_hmac_key = base64.b64encode(b"m" * 32).decode("ascii")
    settings.telegram_bot_token = "111111111:" + "p" * 35
    return settings


class StubResponse:
    def __init__(self, data: dict):
        self.data = data

    def json(self) -> dict:
        return self.data


class StubBotApi:
    def __init__(self, *, admin: bool = True, bot_id: int = 123456789):
        self.calls: list[tuple[str, dict | None]] = []
        self.admin = admin
        self.bot_id = bot_id

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, url: str, json: dict | None = None):
        self.calls.append((url.rsplit("/", 1)[-1], json))
        method = self.calls[-1][0]
        if method == "getMe":
            return StubResponse({"ok": True, "result": {
                "is_bot": True, "id": self.bot_id,
            }})
        if method == "getChatMember":
            return StubResponse({"ok": True, "result": {
                "status": "administrator",
                "can_invite_users": self.admin,
            }})
        if method == "setWebhook":
            return StubResponse({"ok": True, "result": True})
        raise AssertionError("Unexpected Bot API method")


@pytest.mark.asyncio
async def test_dry_run_never_calls_telegram_or_needs_bot_token(test_app, monkeypatch):
    settings = configure(test_app)

    def no_network(**_kwargs):
        raise AssertionError("Dry-run initiated a network client")

    monkeypatch.setattr(setup.httpx, "AsyncClient", no_network)
    await setup.configure_webhook(settings, PUBLIC_URL, apply=False)
    assert setup.validate_setup(settings, PUBLIC_URL)


@pytest.mark.asyncio
async def test_apply_checks_bot_identity_permissions_and_sets_scoped_consent_updates(
    test_app, monkeypatch,
):
    settings = configure(test_app)
    fake = StubBotApi()
    monkeypatch.setattr(setup.httpx, "AsyncClient", lambda **_kwargs: fake)
    await setup.configure_webhook(settings, PUBLIC_URL, apply=True, bot_token=TOKEN)
    assert [method for method, _ in fake.calls] == [
        "getMe", "getChatMember", "setWebhook",
    ]
    assert fake.calls[1][1] == {
        "chat_id": "-100123456789", "user_id": 123456789,
    }
    assert fake.calls[2][1] == {
        "url": PUBLIC_URL,
        "secret_token": settings.tginvite_consent_webhook_secret,
        "allowed_updates": ["chat_join_request", "message"],
        "max_connections": 5,
        "drop_pending_updates": False,
    }


@pytest.mark.asyncio
async def test_apply_fails_before_setwebhook_for_bad_bot_identity_or_rights(
    test_app, monkeypatch
):
    settings = configure(test_app)
    for fake in [StubBotApi(bot_id=987654321), StubBotApi(admin=False)]:
        monkeypatch.setattr(setup.httpx, "AsyncClient", lambda current=fake, **_kwargs: current)
        with pytest.raises(setup.SetupRejected):
            await setup.configure_webhook(settings, PUBLIC_URL, apply=True, bot_token=TOKEN)
        assert "setWebhook" not in [method for method, _ in fake.calls]


@pytest.mark.asyncio
async def test_setup_rejects_primary_bot_token_and_malformed_url(test_app):
    settings = configure(test_app)
    with pytest.raises(setup.SetupRejected):
        await setup.configure_webhook(
            settings, PUBLIC_URL, apply=True, bot_token=settings.telegram_bot_token
        )
    for url in [
        "http://example.org/api/v1/tginvite/consent-webhook",
        "https://127.0.0.1/api/v1/tginvite/consent-webhook",
        "https://example.org:bad/api/v1/tginvite/consent-webhook",
        "https://example.org/api/v1/tginvite/consent-webhook?token=secret",
        "https://example.org/telegram/webhook",
    ]:
        with pytest.raises(setup.SetupRejected):
            setup.validate_setup(settings, url)


@pytest.mark.asyncio
async def test_setup_never_exposes_token_in_upstream_errors(test_app, monkeypatch):
    settings = configure(test_app)

    class FailingApi:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            raise RuntimeError(f"https://api.telegram.org/bot{TOKEN}/getMe")

    monkeypatch.setattr(setup.httpx, "AsyncClient", lambda **_kwargs: FailingApi())
    with pytest.raises(setup.SetupRejected) as caught:
        await setup.configure_webhook(settings, PUBLIC_URL, apply=True, bot_token=TOKEN)
    assert TOKEN not in str(caught.value)
