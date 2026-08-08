from sqlalchemy import select

from app.core.security import verify_password
from app.models.subscription_order import SubscriptionOrder
from app.models.user import User


INTERNAL_HEADERS = {"X-Dev-Internal": "miniapp-subscription"}


def order_payload(char: str) -> str:
    return "sub:" + char * 64


async def test_subscription_api_requires_internal_auth(client):
    response = await client.post(
        "/api/v1/subscriptions/orders",
        json={
            "payload": order_payload("a"),
            "telegram_user_id": 101,
            "username": "alice",
            "login": "alice_pro",
            "amount_usd": 1000,
        },
    )
    assert response.status_code == 403


async def test_subscription_order_lifecycle_is_persistent_and_idempotent(client, test_app):
    payload = order_payload("b")
    password = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

    create_response = await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json={
            "payload": payload,
            "telegram_user_id": 202,
            "username": "bob",
            "login": "bob_pro",
            "amount_usd": 1000,
        },
    )
    assert create_response.status_code == 201
    assert create_response.json()["status"] == "pending"
    assert create_response.json()["password"] is None

    invoice_response = await client.patch(
        f"/api/v1/subscriptions/orders/{payload}/invoice",
        headers=INTERNAL_HEADERS,
        json={"invoice_link": "https://t.me/$test-invoice"},
    )
    assert invoice_response.status_code == 200
    assert invoice_response.json()["invoice_link"] == "https://t.me/$test-invoice"

    complete_response = await client.post(
        f"/api/v1/subscriptions/orders/{payload}/complete",
        headers=INTERNAL_HEADERS,
        json={
            "password": password,
            "provider_charge_id": "provider-1",
            "telegram_payment_charge_id": "telegram-1",
        },
    )
    assert complete_response.status_code == 200
    completed = complete_response.json()
    assert completed["status"] == "paid"
    assert completed["password"] == password
    assert completed["already_paid"] is False
    assert completed["subscription_expires_at"]

    duplicate_response = await client.post(
        f"/api/v1/subscriptions/orders/{payload}/complete",
        headers=INTERNAL_HEADERS,
        json={
            "password": "Z" * 32,
            "provider_charge_id": "provider-1",
            "telegram_payment_charge_id": "telegram-1",
        },
    )
    assert duplicate_response.status_code == 200
    duplicate = duplicate_response.json()
    assert duplicate["already_paid"] is True
    assert duplicate["password"] == password

    read_response = await client.get(
        f"/api/v1/subscriptions/orders/{payload}",
        headers=INTERNAL_HEADERS,
    )
    assert read_response.status_code == 200
    assert read_response.json()["password"] == password

    async with test_app.state.sessionmaker() as session:
        order_result = await session.execute(
            select(SubscriptionOrder).where(SubscriptionOrder.payload == payload)
        )
        order = order_result.scalar_one()
        assert order.password_ciphertext
        assert order.password_ciphertext != password

        user_result = await session.execute(select(User).where(User.telegram_id == "202"))
        user = user_result.scalar_one()
        assert user.email == "bob_pro"
        assert user.hashed_password
        assert verify_password(password, user.hashed_password)


async def test_pending_order_reserves_login_for_other_telegram_users(client):
    first = await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json={
            "payload": order_payload("c"),
            "telegram_user_id": 301,
            "username": "first",
            "login": "reserved_login",
            "amount_usd": 1000,
        },
    )
    assert first.status_code == 201

    second = await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json={
            "payload": order_payload("d"),
            "telegram_user_id": 302,
            "username": "second",
            "login": "reserved_login",
            "amount_usd": 1000,
        },
    )
    assert second.status_code == 409
