import pytest

from tests.conftest import (
    TEST_SUBSCRIPTION_ADMIN_KEY,
    TEST_SUBSCRIPTION_INTERNAL_KEY,
)


READ_HEADERS = {"X-API-Key": TEST_SUBSCRIPTION_INTERNAL_KEY}
ADMIN_HEADERS = {"X-API-Key": TEST_SUBSCRIPTION_ADMIN_KEY}


@pytest.mark.asyncio
async def test_subscription_settings_can_be_read_and_updated_via_internal_admin_api(client):
    initial = await client.get(
        "/api/v1/subscriptions/settings",
        headers=READ_HEADERS,
    )
    assert initial.status_code == 200

    payload = {
        "monthly_price_sol": "0.125000001",
        "monthly_price_usdt": "4.250001",
        "free_demo_enabled": True,
        "demo_days": 14,
        "solana_recipient_wallet": "11111111111111111111111111111111",
    }
    updated = await client.put(
        "/api/v1/subscriptions/settings",
        headers=ADMIN_HEADERS,
        json=payload,
    )
    assert updated.status_code == 200
    body = updated.json()
    assert body["free_demo_enabled"] is True
    assert body["demo_days"] == 14
    assert body["solana_recipient_wallet"] == payload["solana_recipient_wallet"]
    assert str(body["monthly_price_sol"]) == payload["monthly_price_sol"]
    assert str(body["monthly_price_usdt"]) == payload["monthly_price_usdt"]

    reread = await client.get(
        "/api/v1/subscriptions/settings",
        headers=READ_HEADERS,
    )
    assert reread.status_code == 200
    assert reread.json()["demo_days"] == 14


@pytest.mark.asyncio
async def test_subscription_settings_reject_invalid_wallet(client):
    response = await client.put(
        "/api/v1/subscriptions/settings",
        headers=ADMIN_HEADERS,
        json={
            "monthly_price_sol": "0",
            "monthly_price_usdt": "0",
            "free_demo_enabled": False,
            "demo_days": 30,
            "solana_recipient_wallet": "not-a-solana-wallet",
        },
    )

    assert response.status_code == 422
    assert "valid Solana public key" in response.json()["detail"]
