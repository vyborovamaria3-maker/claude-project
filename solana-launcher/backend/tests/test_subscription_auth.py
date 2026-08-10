import hashlib
import hmac
import json
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

from app.core.security import get_password_hash
from app.models.auth_log import AuthLog
from app.models.user import User
from sqlalchemy import select

ACCESS_PASSWORD = "ABCDEFGHJKLMNPQRSTUVWXYZ2345678"


def make_telegram_init_data(bot_token: str, user: dict) -> str:
    params = {
        "auth_date": str(int(datetime.now(UTC).timestamp())),
        "user": json.dumps(user, separators=(",", ":"), ensure_ascii=False),
    }
    data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(params.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    params["hash"] = hmac.new(secret, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    return urlencode(params)


async def create_subscription_user(test_app, *, login: str, telegram_id: str, expires_at: datetime):
    async with test_app.state.sessionmaker() as session:
        user = User(
            access_login=login,
            telegram_id=telegram_id,
            hashed_password=get_password_hash(ACCESS_PASSWORD),
            subscription_expires_at=expires_at,
            is_active=True,
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user.id


async def test_subscription_password_login_and_me_work_with_non_email_login(client, test_app):
    await create_subscription_user(
        test_app,
        login="miniapp_user",
        telegram_id="10001",
        expires_at=datetime.now(UTC) + timedelta(days=7),
    )

    login = await client.post(
        "/api/v1/auth/login-password",
        headers={"User-Agent": "BacktestBrowser/1.0"},
        json={"login": "miniapp_user", "password": ACCESS_PASSWORD},
    )
    assert login.status_code == 200, login.text
    token = login.json()["access_token"]
    assert token

    me = await client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert me.status_code == 200, me.text
    assert me.json()["access_login"] == "miniapp_user"
    assert me.json()["email"] is None
    assert me.json()["subscription_expires_at"] is not None


async def test_expired_subscription_cannot_login(client, test_app):
    await create_subscription_user(
        test_app,
        login="expired_user",
        telegram_id="10002",
        expires_at=datetime.now(UTC) - timedelta(seconds=1),
    )

    response = await client.post(
        "/api/v1/auth/login-password",
        json={"login": "expired_user", "password": ACCESS_PASSWORD},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "Active subscription required"


async def test_existing_jwt_stops_working_when_subscription_expires(client, test_app):
    user_id = await create_subscription_user(
        test_app,
        login="token_expiry",
        telegram_id="10003",
        expires_at=datetime.now(UTC) + timedelta(days=1),
    )

    login = await client.post(
        "/api/v1/auth/login-password",
        json={"login": "token_expiry", "password": ACCESS_PASSWORD},
    )
    assert login.status_code == 200
    token = login.json()["access_token"]

    async with test_app.state.sessionmaker() as session:
        user = await session.get(User, user_id)
        assert user is not None
        user.subscription_expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()

    me = await client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert me.status_code == 403
    assert me.json()["detail"] == "Active subscription required"


async def test_regular_email_login_cannot_bypass_subscription(client, test_app):
    async with test_app.state.sessionmaker() as session:
        user = User(
            email="plain@example.com",
            hashed_password=get_password_hash("ExamplePassword123!"),
            is_active=True,
            subscription_expires_at=None,
        )
        session.add(user)
        await session.commit()

    response = await client.post(
        "/api/v1/auth/login-json",
        json={"email": "plain@example.com", "password": "ExamplePassword123!"},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "Active subscription required"


async def test_failed_password_login_is_audited_without_password(client, test_app):
    await create_subscription_user(
        test_app,
        login="audit_user",
        telegram_id="10004",
        expires_at=datetime.now(UTC) + timedelta(days=7),
    )

    response = await client.post(
        "/api/v1/auth/login-password",
        headers={"User-Agent": "AuditBacktest/2.0"},
        json={"login": "audit_user", "password": "Z" * 32},
    )
    assert response.status_code == 401

    async with test_app.state.sessionmaker() as session:
        result = await session.execute(
            select(AuthLog)
            .where(AuthLog.event_type == "password_login")
            .where(AuthLog.success.is_(False))
            .order_by(AuthLog.created_at.desc())
        )
        log = result.scalars().first()
        assert log is not None
        assert log.user_agent == "AuditBacktest/2.0"
        assert "password" not in str(log.meta).lower()
        assert "ZZZZ" not in str(log.meta)
        assert "ZZZZ" not in str(log.error_message)


async def test_telegram_verify_does_not_create_unsubscribed_user(client, test_app):
    bot_token = "123456:backtest-token"
    test_app.state.settings.telegram_bot_token = bot_token
    init_data = make_telegram_init_data(
        bot_token,
        {
            "id": 20001,
            "username": "new_user",
            "first_name": "New",
            "language_code": "ru",
        },
    )

    response = await client.post(
        "/api/v1/auth/telegram/verify",
        json={"init_data": init_data},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "Active subscription required"

    async with test_app.state.sessionmaker() as session:
        result = await session.execute(select(User).where(User.telegram_id == "20001"))
        assert result.scalar_one_or_none() is None
