from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.security import verify_password
from app.models.auth_log import AuthLog
from app.models.subscription_order import SubscriptionOrder
from app.models.subscription_settings import SubscriptionSettings
from app.models.user import User

pytestmark = pytest.mark.usefixtures("configured_subscription_settings")

INTERNAL_HEADERS = {"X-Dev-Internal": "miniapp-subscription"}
RECIPIENT = "11111111111111111111111111111111"
PASSWORD_ALPHABET = set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")


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
    telegram_profile: dict | None = None,
):
    return {
        "payload": payload,
        "telegram_user_id": telegram_user_id,
        "username": username,
        "telegram_profile": telegram_profile,
        "login": login,
        "currency": currency,
        "total_amount": total_amount,
        "access_days": 30,
        "recipient_wallet": RECIPIENT,
        "payment_reference": ref,
        "payment_url": f"solana:{RECIPIENT}?reference={ref}",
    }


def demo_order_body(
    *,
    payload: str,
    telegram_user_id: int,
    login: str,
    days: int = 14,
    telegram_profile: dict | None = None,
):
    return {
        "payload": payload,
        "telegram_user_id": telegram_user_id,
        "username": "demo",
        "telegram_profile": telegram_profile,
        "login": login,
        "currency": "DEMO",
        "total_amount": 0,
        "access_days": days,
        "recipient_wallet": None,
        "payment_reference": None,
        "payment_url": None,
    }


async def create_order(client, body: dict):
    return await client.post(
        "/api/v1/subscriptions/orders",
        headers=INTERNAL_HEADERS,
        json=body,
    )


async def complete_paid(client, payload: str, signature: str):
    response = await client.post(
        f"/api/v1/subscriptions/orders/{payload}/complete",
        headers=INTERNAL_HEADERS,
        json={"payment_signature": signature},
    )
    assert response.status_code == 200, response.text
    return response.json()


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


async def test_subscription_settings_have_safe_defaults(client, test_app):
    async with test_app.state.sessionmaker() as session:
        settings = await session.get(SubscriptionSettings, 1)
        assert settings is not None
        settings.monthly_price_sol = Decimal("0")
        settings.monthly_price_usdt = Decimal("0")
        settings.paid_subscriptions_enabled = False
        settings.free_demo_enabled = False
        settings.demo_days = 30
        settings.solana_recipient_wallet = ""
        await session.commit()

    response = await client.get(
        "/api/v1/subscriptions/settings",
        headers=INTERNAL_HEADERS,
    )
    assert response.status_code == 200
    data = response.json()
    assert Decimal(str(data["monthly_price_sol"])) == 0
    assert Decimal(str(data["monthly_price_usdt"])) == 0
    assert data["paid_subscriptions_enabled"] is False
    assert data["free_demo_enabled"] is False
    assert data["demo_days"] == 30
    assert data["solana_recipient_wallet"] == ""


async def test_backend_rejects_paid_order_that_does_not_match_admin_policy(client):
    wrong_amount = await create_order(
        client,
        paid_order_body(
            payload=order_payload("1"),
            telegram_user_id=1101,
            login="wrong_amount",
            ref="ref-policy-amount",
            total_amount=1,
        ),
    )
    assert wrong_amount.status_code == 409
    assert "amount" in wrong_amount.json()["detail"].lower()

    wrong_recipient = paid_order_body(
        payload=order_payload("2"),
        telegram_user_id=1102,
        login="wrong_recipient",
        ref="ref-policy-recipient",
    )
    wrong_recipient["recipient_wallet"] = "SysvarRent111111111111111111111111111111111"
    wrong_recipient["payment_url"] = (
        "solana:SysvarRent111111111111111111111111111111111"
        "?reference=ref-policy-recipient"
    )
    response = await create_order(client, wrong_recipient)
    assert response.status_code == 409
    assert "recipient" in response.json()["detail"].lower()


async def test_backend_rejects_new_access_when_admin_mode_is_disabled(client, test_app):
    async with test_app.state.sessionmaker() as session:
        settings = await session.get(SubscriptionSettings, 1)
        assert settings is not None
        settings.paid_subscriptions_enabled = False
        settings.free_demo_enabled = False
        await session.commit()

    paid = await create_order(
        client,
        paid_order_body(
            payload=order_payload("3"),
            telegram_user_id=1201,
            login="paid_disabled",
            ref="ref-disabled-paid",
        ),
    )
    assert paid.status_code == 409

    demo = await create_order(
        client,
        demo_order_body(
            payload=order_payload("4"),
            telegram_user_id=1202,
            login="demo_disabled",
        ),
    )
    assert demo.status_code == 409


async def test_subscription_lifecycle_persists_profile_and_credentials(
    client,
    test_app,
):
    payload = order_payload("b")
    telegram_profile = {
        "id": 202,
        "username": "bob",
        "first_name": "Bob",
        "last_name": "Trader",
        "language_code": "ru",
        "is_premium": True,
        "added_to_attachment_menu": True,
        "allows_write_to_pm": True,
        "photo_url": "https://example.test/bob.jpg",
    }
    body = paid_order_body(
        payload=payload,
        telegram_user_id=202,
        username="bob",
        telegram_profile=telegram_profile,
        login="bob_pro",
        ref="ref-b",
    )

    create_response = await create_order(client, body)
    assert create_response.status_code == 201
    created = create_response.json()
    assert created["status"] == "pending"
    assert created["password"] is None

    completed = await complete_paid(client, payload, "signature-b")
    password = completed["password"]
    assert completed["status"] == "paid"
    assert isinstance(password, str)
    assert len(password) == 32
    assert set(password) <= PASSWORD_ALPHABET
    assert completed["payment_signature"] == "signature-b"
    assert completed["already_paid"] is False

    duplicate = await complete_paid(client, payload, "signature-b")
    assert duplicate["already_paid"] is True
    assert duplicate["password"] == password

    async with test_app.state.sessionmaker() as session:
        order = await session.get(SubscriptionOrder, payload)
        assert order is not None
        assert order.password_ciphertext
        assert order.password_ciphertext != password
        assert order.payment_signature == "signature-b"
        assert order.telegram_profile == telegram_profile

        user_result = await session.execute(
            select(User).where(User.telegram_id == "202")
        )
        user = user_result.scalar_one()
        assert user.access_login == "bob_pro"
        assert user.email is None
        assert user.hashed_password
        assert verify_password(password, user.hashed_password)
        assert user.telegram_username == "bob"
        assert user.first_name == "Bob"
        assert user.last_name == "Trader"
        assert user.full_name == "Bob Trader"
        assert user.telegram_language_code == "ru"
        assert user.telegram_is_premium is True
        assert user.telegram_added_to_attachment_menu is True
        assert user.telegram_allows_write_to_pm is True
        assert user.photo_url == "https://example.test/bob.jpg"
        assert user.telegram_profile == telegram_profile

        access_logs = await session.execute(
            select(AuthLog)
            .where(AuthLog.telegram_id == "202")
            .where(AuthLog.provider == "telegram_miniapp")
            .order_by(AuthLog.created_at)
        )
        logs = access_logs.scalars().all()
        events = [row.event_type for row in logs]
        assert "subscription_access_requested" in events
        assert "subscription_credentials_issued" in events
        issued = next(
            row for row in logs if row.event_type == "subscription_credentials_issued"
        )
        assert issued.user_id == user.id
        assert "password" not in str(issued.meta).lower()


async def test_completion_rejects_caller_supplied_password(client):
    payload = order_payload("c")
    create = await create_order(
        client,
        paid_order_body(
            payload=payload,
            telegram_user_id=240,
            login="server_password",
            ref="ref-c",
        ),
    )
    assert create.status_code == 201

    complete = await client.post(
        f"/api/v1/subscriptions/orders/{payload}/complete",
        headers=INTERNAL_HEADERS,
        json={"payment_signature": "signature-c", "password": "A" * 32},
    )
    assert complete.status_code == 422


async def test_telegram_profile_id_must_match_order_owner(client):
    response = await create_order(
        client,
        paid_order_body(
            payload=order_payload("d"),
            telegram_user_id=250,
            login="profile_mismatch",
            ref="ref-d",
            telegram_profile={"id": 999, "username": "wrong"},
        ),
    )
    assert response.status_code == 422


async def test_paid_order_requires_verified_signature(client):
    payload = order_payload("e")
    create = await create_order(
        client,
        paid_order_body(
            payload=payload,
            telegram_user_id=260,
            login="signature_test",
            ref="ref-e",
        ),
    )
    assert create.status_code == 201

    complete = await client.post(
        f"/api/v1/subscriptions/orders/{payload}/complete",
        headers=INTERNAL_HEADERS,
        json={"payment_signature": None},
    )
    assert complete.status_code == 409


async def test_currency_switch_reuses_pending_payment_instead_of_orphaning_it(client):
    first_payload = order_payload("f")
    first = await create_order(
        client,
        paid_order_body(
            payload=first_payload,
            telegram_user_id=301,
            username="first",
            login="retry_login",
            ref="ref-f",
        ),
    )
    assert first.status_code == 201

    retry = await create_order(
        client,
        paid_order_body(
            payload=order_payload("g"),
            telegram_user_id=301,
            username="first",
            login="retry_login",
            ref="ref-g",
            currency="USDT",
            total_amount=50_000_000,
        ),
    )
    assert retry.status_code == 201
    assert retry.json()["payload"] == first_payload
    assert retry.json()["currency"] == "SOL"
    assert retry.json()["payment_reference"] == "ref-f"

    old = await client.get(
        f"/api/v1/subscriptions/orders/{first_payload}",
        headers=INTERNAL_HEADERS,
    )
    assert old.status_code == 200
    assert old.json()["status"] == "pending"


async def test_existing_pending_payment_survives_later_admin_price_change(client, test_app):
    payload = order_payload("5")
    first = await create_order(
        client,
        paid_order_body(
            payload=payload,
            telegram_user_id=1301,
            login="price_changed",
            ref="ref-old-price",
        ),
    )
    assert first.status_code == 201

    async with test_app.state.sessionmaker() as session:
        settings = await session.get(SubscriptionSettings, 1)
        assert settings is not None
        settings.monthly_price_sol = Decimal("0.75")
        settings.paid_subscriptions_enabled = False
        await session.commit()

    reused = await create_order(
        client,
        paid_order_body(
            payload=order_payload("6"),
            telegram_user_id=1301,
            login="price_changed",
            ref="ref-new-price",
            total_amount=750_000_000,
        ),
    )
    assert reused.status_code == 201
    assert reused.json()["payload"] == payload
    assert reused.json()["total_amount"] == 250_000_000


async def test_one_user_cannot_reserve_second_login_while_checkout_pending(client):
    first = await create_order(
        client,
        paid_order_body(
            payload=order_payload("h"),
            telegram_user_id=350,
            login="first_login",
            ref="ref-h",
        ),
    )
    assert first.status_code == 201

    second = await create_order(
        client,
        paid_order_body(
            payload=order_payload("i"),
            telegram_user_id=350,
            login="second_login",
            ref="ref-i",
        ),
    )
    assert second.status_code == 409


async def test_pending_order_reserves_login_for_other_telegram_users(client):
    first = await create_order(
        client,
        paid_order_body(
            payload=order_payload("j"),
            telegram_user_id=401,
            username="first",
            login="reserved_login",
            ref="ref-j",
        ),
    )
    assert first.status_code == 201

    second = await create_order(
        client,
        paid_order_body(
            payload=order_payload("k"),
            telegram_user_id=402,
            username="second",
            login="reserved_login",
            ref="ref-k",
        ),
    )
    assert second.status_code == 409


async def test_free_demo_is_idempotent_recoverable_and_one_time(client, test_app):
    payload = order_payload("l")
    body = demo_order_body(
        payload=payload,
        telegram_user_id=501,
        login="demo_login",
        days=14,
        telegram_profile={
            "id": 501,
            "first_name": "Demo",
            "language_code": "en",
            "is_premium": False,
        },
    )
    create = await create_order(client, body)
    assert create.status_code == 201

    complete = await client.post(
        f"/api/v1/subscriptions/orders/{payload}/complete",
        headers=INTERNAL_HEADERS,
        json={},
    )
    assert complete.status_code == 200
    completed = complete.json()
    password = completed["password"]
    assert completed["status"] == "paid"
    assert isinstance(password, str) and len(password) == 32

    async with test_app.state.sessionmaker() as session:
        user_result = await session.execute(
            select(User).where(User.telegram_id == "501")
        )
        user = user_result.scalar_one()
        assert user.access_login == "demo_login"
        assert user.email is None
        assert user.first_name == "Demo"
        assert user.telegram_language_code == "en"
        assert user.telegram_is_premium is False
        assert verify_password(password, user.hashed_password)

    duplicate_demo = await create_order(
        client,
        demo_order_body(
            payload=order_payload("m"),
            telegram_user_id=501,
            login="demo_login",
            days=14,
        ),
    )
    assert duplicate_demo.status_code == 201
    assert duplicate_demo.json()["payload"] == payload
    assert duplicate_demo.json()["password"] == password

    different_login = await create_order(
        client,
        demo_order_body(
            payload=order_payload("n"),
            telegram_user_id=501,
            login="another_demo",
            days=14,
        ),
    )
    assert different_login.status_code == 409


async def test_demo_cannot_extend_existing_paid_subscription(client):
    paid_payload = order_payload("o")
    create = await create_order(
        client,
        paid_order_body(
            payload=paid_payload,
            telegram_user_id=550,
            login="paid_before_demo",
            ref="ref-o",
        ),
    )
    assert create.status_code == 201
    await complete_paid(client, paid_payload, "signature-o")

    demo = await create_order(
        client,
        demo_order_body(
            payload=order_payload("p"),
            telegram_user_id=550,
            login="paid_before_demo",
        ),
    )
    assert demo.status_code == 409


async def test_renewal_keeps_password_and_extends_expiry(client):
    first_payload = order_payload("q")
    first_create = await create_order(
        client,
        paid_order_body(
            payload=first_payload,
            telegram_user_id=601,
            login="renew_user",
            ref="ref-q",
        ),
    )
    assert first_create.status_code == 201
    first = await complete_paid(client, first_payload, "signature-q")
    first_password = first["password"]
    first_expiry = datetime.fromisoformat(first["subscription_expires_at"])

    second_payload = order_payload("r")
    second_create = await create_order(
        client,
        paid_order_body(
            payload=second_payload,
            telegram_user_id=601,
            login="renew_user",
            ref="ref-r",
        ),
    )
    assert second_create.status_code == 201
    second = await complete_paid(client, second_payload, "signature-r")
    second_expiry = datetime.fromisoformat(second["subscription_expires_at"])

    assert second["password"] == first_password
    assert second_expiry >= first_expiry + timedelta(days=29, hours=23)

    historical = await client.get(
        f"/api/v1/subscriptions/orders/{first_payload}",
        headers=INTERNAL_HEADERS,
    )
    assert historical.status_code == 200
    assert historical.json()["password"] == first_password


async def test_latest_access_recovery_returns_current_credentials(client, test_app):
    payload = order_payload("s")
    create = await create_order(
        client,
        paid_order_body(
            payload=payload,
            telegram_user_id=701,
            login="recover_me",
            ref="ref-s",
        ),
    )
    assert create.status_code == 201
    completed = await complete_paid(client, payload, "signature-s")

    recovered = await client.get(
        "/api/v1/subscriptions/users/701/access",
        headers=INTERNAL_HEADERS,
    )
    assert recovered.status_code == 200
    assert recovered.json()["login"] == "recover_me"
    assert recovered.json()["password"] == completed["password"]

    async with test_app.state.sessionmaker() as session:
        result = await session.execute(
            select(User).where(User.telegram_id == "701")
        )
        user = result.scalar_one()
        user.subscription_expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()

    expired = await client.get(
        "/api/v1/subscriptions/users/701/access",
        headers=INTERNAL_HEADERS,
    )
    assert expired.status_code == 404


async def test_existing_telegram_account_cannot_change_site_login(client):
    first_payload = order_payload("t")
    first = await create_order(
        client,
        paid_order_body(
            payload=first_payload,
            telegram_user_id=801,
            login="fixed_login",
            ref="ref-t",
        ),
    )
    assert first.status_code == 201
    await complete_paid(client, first_payload, "signature-t")

    second = await create_order(
        client,
        paid_order_body(
            payload=order_payload("u"),
            telegram_user_id=801,
            login="changed_login",
            ref="ref-u",
        ),
    )
    assert second.status_code == 409
