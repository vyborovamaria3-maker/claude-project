from decimal import Decimal

from app.core.security import verify_password
from app.models.subscription_order import SubscriptionOrder
from app.models.user import User
from sqlalchemy import select
from tests.conftest import TEST_SUBSCRIPTION_INTERNAL_KEY

INTERNAL_HEADERS = {"X-API-Key": TEST_SUBSCRIPTION_INTERNAL_KEY}
RECIPIENT = "11111111111111111111111111111111"


def order_payload(char: str) -> str:
    return "sub:" + char * 64


def paid_order_body(
    *,
    payload: str,
    telegram_user_id: int,
    login: str,
    ref: str,
    currency: str = "SOL",
    total_amount: int = 250_000_000,
    username: str | None = None,
):
    return {
        "payload": payload,
        "telegram_user_id": telegram_user_id,
        "username": username,
        "login": login,
        "currency": currency,
        "total_amount": total_amount,
        "access_days": 30,
        "recipient_wallet": RECIPIENT,
        "payment_reference": ref,
        "payment_url": f"solana:{RECIPIENT}?reference={ref}",
    }


def demo_order_body(*, payload: str, telegram_user_id: int, login: str, days: int = 7):
    return {
        "payload": payload,
        "telegram_user_id": telegram_user_id,
        "username": "demo",
        "login": login,
        "currency": "DEMO",
        "total_amount": 0,
        "access_days": days,
        "recipient_wallet": None,
        "payment_reference": None,
        "payment_url": None,
    }


async def test_subscription_api_requires_internal_auth(client):
    response = await client.post(
        "/api/v1/subscriptions/orders",
        json=paid_order_body(
            payload=order_payload("a"),
            telegram_user_id=101,
            username="alice",
            login="alice_pro",
            ref="ref-a",
        ),
    )
    assert response.status_code == 403


async def test_subscription_settings_have_safe_defaults(client):
    response = await client.get(
        "/api/v1/subscriptions/settings",
        headers=INTERNAL_HEADERS,
    )
    assert response.status_code == 200
    data = response.json()
    assert Decimal(str(data["monthly_price_sol"])) == 0
    assert Decimal(str(data["monthly_price_usdt"])) == 0
    assert data["free_demo_enabled"] is False
    assert data["demo_days"] == 30
    assert data["solana_recipient_wallet"] == ""


async def test_solana_subscription_order_lifecycle_is_persistent_and_idempotent(client, test_app):
    payload = order_payload("b")
    password = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

    create_response = await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json=paid_order_body(
            payload=payload,
            telegram_user_id=202,
            username="bob",
            login="bob_pro",
            ref="ref-b",
        ),
    )
    assert create_response.status_code == 201
    created = create_response.json()
    assert created["status"] == "pending"
    assert created["currency"] == "SOL"
    assert created["total_amount"] == 250_000_000
    assert created["access_days"] == 30
    assert created["payment_reference"] == "ref-b"
    assert created["password"] is None

    complete_response = await client.post(
        f"/api/v1/subscriptions/orders/{payload}/complete",
        headers=INTERNAL_HEADERS,
        json={"password": password, "payment_signature": "signature-b"},
    )
    assert complete_response.status_code == 200
    completed = complete_response.json()
    assert completed["status"] == "paid"
    assert completed["password"] == password
    assert completed["payment_signature"] == "signature-b"
    assert completed["already_paid"] is False
    assert completed["subscription_expires_at"]

    duplicate_response = await client.post(
        f"/api/v1/subscriptions/orders/{payload}/complete",
        headers=INTERNAL_HEADERS,
        json={"password": "Z" * 32, "payment_signature": "signature-b"},
    )
    assert duplicate_response.status_code == 200
    duplicate = duplicate_response.json()
    assert duplicate["already_paid"] is True
    assert duplicate["password"] == password

    async with test_app.state.sessionmaker() as session:
        order_result = await session.execute(
            select(SubscriptionOrder).where(SubscriptionOrder.payload == payload)
        )
        order = order_result.scalar_one()
        assert order.password_ciphertext
        assert order.password_ciphertext != password
        assert order.payment_signature == "signature-b"

        user_result = await session.execute(select(User).where(User.telegram_id == "202"))
        user = user_result.scalar_one()
        assert user.email == "bob_pro"
        assert user.hashed_password
        assert verify_password(password, user.hashed_password)


async def test_paid_order_requires_verified_signature(client):
    payload = order_payload("c")
    create = await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json=paid_order_body(
            payload=payload,
            telegram_user_id=250,
            login="signature_test",
            ref="ref-c",
        ),
    )
    assert create.status_code == 201

    complete = await client.post(
        f"/api/v1/subscriptions/orders/{payload}/complete",
        headers=INTERNAL_HEADERS,
        json={"password": "A" * 32, "payment_signature": None},
    )
    assert complete.status_code == 409


async def test_same_user_reuses_matching_pending_order(client):
    first_payload = order_payload("d")
    first = await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json=paid_order_body(
            payload=first_payload,
            telegram_user_id=301,
            username="first",
            login="retry_login",
            ref="ref-d",
        ),
    )
    assert first.status_code == 201

    retry = await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json=paid_order_body(
            payload=order_payload("e"),
            telegram_user_id=301,
            username="first",
            login="retry_login",
            ref="ref-e",
        ),
    )
    assert retry.status_code == 201
    assert retry.json()["payload"] == first_payload
    assert retry.json()["payment_reference"] == "ref-d"


async def test_same_user_can_switch_payment_method(client):
    first_payload = order_payload("f")
    first = await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json=paid_order_body(
            payload=first_payload,
            telegram_user_id=350,
            login="switch_login",
            ref="ref-f",
        ),
    )
    assert first.status_code == 201

    second_payload = order_payload("g")
    second = await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json=paid_order_body(
            payload=second_payload,
            telegram_user_id=350,
            login="switch_login",
            ref="ref-g",
            currency="USDT",
            total_amount=50_000_000,
        ),
    )
    assert second.status_code == 201
    assert second.json()["payload"] == second_payload
    assert second.json()["currency"] == "USDT"

    old = await client.get(
        f"/api/v1/subscriptions/orders/{first_payload}",
        headers=INTERNAL_HEADERS,
    )
    assert old.status_code == 200
    assert old.json()["status"] == "cancelled"


async def test_pending_order_reserves_login_for_other_telegram_users(client):
    first = await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json=paid_order_body(
            payload=order_payload("h"),
            telegram_user_id=401,
            username="first",
            login="reserved_login",
            ref="ref-h",
        ),
    )
    assert first.status_code == 201

    second = await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json=paid_order_body(
            payload=order_payload("i"),
            telegram_user_id=402,
            username="second",
            login="reserved_login",
            ref="ref-i",
        ),
    )
    assert second.status_code == 409


async def test_free_demo_is_one_time_and_needs_no_payment_signature(client):
    payload = order_payload("j")
    create = await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json=demo_order_body(
            payload=payload,
            telegram_user_id=501,
            login="demo_login",
            days=14,
        ),
    )
    assert create.status_code == 201
    assert create.json()["currency"] == "DEMO"
    assert create.json()["total_amount"] == 0
    assert create.json()["access_days"] == 14

    complete = await client.post(
        f"/api/v1/subscriptions/orders/{payload}/complete",
        headers=INTERNAL_HEADERS,
        json={"password": "B" * 32, "payment_signature": None},
    )
    assert complete.status_code == 200
    assert complete.json()["status"] == "paid"

    duplicate_demo = await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json=demo_order_body(
            payload=order_payload("k"),
            telegram_user_id=501,
            login="demo_login",
            days=14,
        ),
    )
    assert duplicate_demo.status_code == 409
