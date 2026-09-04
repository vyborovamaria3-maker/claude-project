from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.api.v1.subscriptions import (
    _require_admin_access,
    _require_checkout_access,
    _require_settings_read_access,
)
from app.core.config import Settings


SECRET = "a9f4c2e8d7b1f6a3c9e5d2b8f7a4c1e9d6b3f8a2c5e7d4b9a1f3c6e8d2b7a5c9"
CHECKOUT_KEY = "c" * 64
ADMIN_KEY = "a" * 64


def make_settings() -> Settings:
    return Settings(
        secret_key=SECRET,
        environment="development",
        subscription_internal_key=CHECKOUT_KEY,
        subscription_admin_key=ADMIN_KEY,
    )


def make_request(api_key: str) -> Request:
    settings = make_settings()
    app = SimpleNamespace(state=SimpleNamespace(settings=settings))
    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/api/v1/subscriptions/settings",
        "raw_path": b"/api/v1/subscriptions/settings",
        "query_string": b"",
        "headers": [(b"x-api-key", api_key.encode())],
        "client": ("127.0.0.1", 12345),
        "server": ("test", 80),
        "app": app,
    }
    return Request(scope)


def test_checkout_key_can_read_settings_and_manage_orders():
    request = make_request(CHECKOUT_KEY)
    assert _require_checkout_access(request).subscription_internal_key == CHECKOUT_KEY
    assert _require_settings_read_access(request).subscription_internal_key == CHECKOUT_KEY


def test_admin_key_can_read_and_update_settings_but_not_manage_orders():
    request = make_request(ADMIN_KEY)
    assert _require_settings_read_access(request).subscription_admin_key == ADMIN_KEY
    assert _require_admin_access(request).subscription_admin_key == ADMIN_KEY
    with pytest.raises(HTTPException) as exc:
        _require_checkout_access(request)
    assert exc.value.status_code == 403


def test_checkout_key_cannot_update_subscription_settings():
    request = make_request(CHECKOUT_KEY)
    with pytest.raises(HTTPException) as exc:
        _require_admin_access(request)
    assert exc.value.status_code == 403
