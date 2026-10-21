"""Subscription permissions verified through real HTTP endpoints and test DB.

Internal checkout credentials may read settings and orders, but only the
separate admin key may change settings.
"""

import pytest

from tests.conftest import (
    TEST_SUBSCRIPTION_ADMIN_KEY,
    TEST_SUBSCRIPTION_INTERNAL_KEY,
)


CHECKOUT = {"X-API-Key": TEST_SUBSCRIPTION_INTERNAL_KEY}
ADMIN = {"X-API-Key": TEST_SUBSCRIPTION_ADMIN_KEY}
SETTINGS = "/api/v1/subscriptions/settings"
ORDER = "/api/v1/subscriptions/orders/nonexistent-order"


@pytest.mark.asyncio
async def test_checkout_can_read_settings_but_cannot_update_them(client):
    before = await client.get(SETTINGS, headers=CHECKOUT)
    assert before.status_code == 200

    forbidden = await client.put(
        SETTINGS,
        headers=CHECKOUT,
        json={"demo_days": 17},
    )
    assert forbidden.status_code == 403

    after = await client.get(SETTINGS, headers=CHECKOUT)
    assert after.status_code == 200
    assert after.json() == before.json()


@pytest.mark.asyncio
async def test_admin_can_update_settings_but_cannot_access_orders(client):
    assert (await client.get(SETTINGS, headers=ADMIN)).status_code == 200

    changed = await client.put(SETTINGS, headers=ADMIN, json={"demo_days": 17})
    assert changed.status_code == 200
    assert changed.json()["demo_days"] == 17

    reread = await client.get(SETTINGS, headers=CHECKOUT)
    assert reread.status_code == 200
    assert reread.json()["demo_days"] == 17

    assert (await client.get(ORDER, headers=ADMIN)).status_code == 403
    assert (await client.get(ORDER, headers=CHECKOUT)).status_code == 404


@pytest.mark.asyncio
async def test_subscription_endpoints_reject_missing_credentials(client):
    assert (await client.get(SETTINGS)).status_code == 403
    assert (await client.put(SETTINGS, json={"demo_days": 17})).status_code == 403
    assert (await client.get(ORDER)).status_code == 403
