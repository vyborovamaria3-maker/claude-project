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


async def test_paid_password_user_can_access_paid_probe(client):
    password = "B" * 32
    provision = await client.post(
        "/api/v1/auth/register-password",
        headers={"X-Dev-Internal": "miniapp-subscription"},
        json={
            "telegram_id": 10001,
            "login": "paid_user",
            "password": password,
            "telegram_username": "paid_user",
        },
    )
    assert provision.status_code == 200

    login = await client.post(
        "/api/v1/auth/login-password",
        json={"login": "paid_user", "password": password},
    )
    assert login.status_code == 200
    token = login.json()["access_token"]

    response = await client.get(
        "/api/v1/users/access",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    assert response.json() == {"active": True}
