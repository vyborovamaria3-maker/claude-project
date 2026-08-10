from datetime import datetime

import pytest

pytestmark = pytest.mark.usefixtures("configured_subscription_settings")

INTERNAL_HEADERS = {"X-Dev-Internal": "miniapp-subscription"}
RECIPIENT = "11111111111111111111111111111111"


def payload(char: str) -> str:
    return "sub:" + char * 64


async def test_active_demo_can_upgrade_to_paid_without_rotating_password(client):
    telegram_id = 91001
    login = "demo_upgrade"

    demo_create = await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json={
            "payload": payload("v"),
            "telegram_user_id": telegram_id,
            "username": "upgrade_user",
            "telegram_profile": {"id": telegram_id, "username": "upgrade_user"},
            "login": login,
            "currency": "DEMO",
            "total_amount": 0,
            "access_days": 14,
            "recipient_wallet": None,
            "payment_reference": None,
            "payment_url": None,
        },
    )
    assert demo_create.status_code == 201, demo_create.text

    demo_complete = await client.post(
        f"/api/v1/subscriptions/orders/{payload('v')}/complete",
        headers=INTERNAL_HEADERS,
        json={},
    )
    assert demo_complete.status_code == 200, demo_complete.text
    demo = demo_complete.json()
    demo_password = demo["password"]
    demo_expiry = datetime.fromisoformat(demo["subscription_expires_at"])

    paid_create = await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json={
            "payload": payload("w"),
            "telegram_user_id": telegram_id,
            "username": "upgrade_user",
            "telegram_profile": {"id": telegram_id, "username": "upgrade_user"},
            "login": login,
            "currency": "SOL",
            "total_amount": 250_000_000,
            "access_days": 30,
            "recipient_wallet": RECIPIENT,
            "payment_reference": "upgrade-reference",
            "payment_url": f"solana:{RECIPIENT}?reference=upgrade-reference",
        },
    )
    assert paid_create.status_code == 201, paid_create.text

    paid_complete = await client.post(
        f"/api/v1/subscriptions/orders/{payload('w')}/complete",
        headers=INTERNAL_HEADERS,
        json={"payment_signature": "upgrade-signature"},
    )
    assert paid_complete.status_code == 200, paid_complete.text
    paid = paid_complete.json()
    paid_expiry = datetime.fromisoformat(paid["subscription_expires_at"])

    assert paid["password"] == demo_password
    assert paid_expiry > demo_expiry


async def test_paid_user_cannot_claim_demo_after_purchase(client):
    telegram_id = 91002
    login = "paid_no_demo"

    paid_create = await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json={
            "payload": payload("x"),
            "telegram_user_id": telegram_id,
            "login": login,
            "currency": "USDT",
            "total_amount": 50_000_000,
            "access_days": 30,
            "recipient_wallet": RECIPIENT,
            "payment_reference": "paid-reference",
            "payment_url": f"solana:{RECIPIENT}?reference=paid-reference",
        },
    )
    assert paid_create.status_code == 201, paid_create.text

    paid_complete = await client.post(
        f"/api/v1/subscriptions/orders/{payload('x')}/complete",
        headers=INTERNAL_HEADERS,
        json={"payment_signature": "paid-signature"},
    )
    assert paid_complete.status_code == 200, paid_complete.text

    demo = await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json={
            "payload": payload("y"),
            "telegram_user_id": telegram_id,
            "login": login,
            "currency": "DEMO",
            "total_amount": 0,
            "access_days": 14,
            "recipient_wallet": None,
            "payment_reference": None,
            "payment_url": None,
        },
    )
    assert demo.status_code == 409
