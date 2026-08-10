import pytest


pytestmark = pytest.mark.asyncio


async def test_registered_user_without_subscription_cannot_access_paid_probe(client):
    password = "A" * 32
    register = await client.post(
        "/api/v1/auth/register",
        json={"email": "free-user@example.com", "password": password},
    )
    assert register.status_code == 201

    login = await client.post(
        "/api/v1/auth/login-json",
        json={"email": "free-user@example.com", "password": password},
    )
    assert login.status_code == 200
    token = login.json()["access_token"]

    response = await client.get(
        "/api/v1/users/access",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "Active subscription required"


async def _create_paid_user(client, *, telegram_id: int, login_name: str, password: str) -> str:
    provision = await client.post(
        "/api/v1/auth/register-password",
        headers={"X-Dev-Internal": "miniapp-subscription"},
        json={
            "telegram_id": telegram_id,
            "login": login_name,
            "password": password,
            "telegram_username": login_name,
        },
    )
    assert provision.status_code == 200

    login = await client.post(
        "/api/v1/auth/login-password",
        json={"login": login_name, "password": password},
    )
    assert login.status_code == 200
    return login.json()["access_token"]


async def test_paid_password_user_can_access_paid_probe(client):
    token = await _create_paid_user(
        client,
        telegram_id=10001,
        login_name="paid_user",
        password="B" * 32,
    )

    response = await client.get(
        "/api/v1/users/access",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    assert response.json() == {"active": True}


async def test_paid_session_cookie_can_authenticate_backend_reads(client):
    token = await _create_paid_user(
        client,
        telegram_id=10002,
        login_name="cookie_user",
        password="C" * 32,
    )

    client.cookies.set("potapoff_access_token", token)
    response = await client.get("/api/v1/users/access")
    assert response.status_code == 200
    assert response.json() == {"active": True}
