import ipaddress
import os
from unittest.mock import patch

import pytest

from app.config import Settings


def strong_settings() -> Settings:
    return Settings(
        environment="production",
        admin_username="admin",
        admin_password="",
        admin_password_hash="scrypt$16384$8$1$YWJjZGVmZ2hpamtsbW5vcA$" + ("QQ" * 32),
        session_secret="s" * 64,
        secure_cookie=True,
        allowed_networks=[ipaddress.ip_network("10.0.0.0/8")],
        allowed_origins=["https://admin.potapoff.fun"],
        solana_rpc_url="https://api.mainnet-beta.solana.com",
    )


def production_env() -> dict[str, str]:
    return {
        "ADMIN_REQUIRE_NETWORK_ALLOWLIST": "true",
        "ADMIN_REQUIRE_MFA": "true",
        "ADMIN_TOTP_SECRET": "JBSWY3DPEHPK3PXP",
        "ADMIN_REQUIRE_REAUTH": "true",
        "ADMIN_SESSION_BIND_IP": "true",
        "ADMIN_SESSION_BIND_USER_AGENT": "true",
    }


def test_production_accepts_strong_admin_policy():
    with patch.dict(os.environ, production_env(), clear=False):
        strong_settings().validate()


@pytest.mark.parametrize(
    "name",
    [
        "ADMIN_REQUIRE_NETWORK_ALLOWLIST",
        "ADMIN_REQUIRE_MFA",
        "ADMIN_REQUIRE_REAUTH",
        "ADMIN_SESSION_BIND_IP",
        "ADMIN_SESSION_BIND_USER_AGENT",
    ],
)
def test_production_rejects_disabled_security_controls(name: str):
    env = production_env()
    env[name] = "false"
    with patch.dict(os.environ, env, clear=False):
        with pytest.raises(RuntimeError):
            strong_settings().validate()


def test_production_rejects_plaintext_admin_password():
    settings = strong_settings()
    settings.admin_password_hash = ""
    settings.admin_password = "temporary-admin-password"
    with patch.dict(os.environ, production_env(), clear=False):
        with pytest.raises(RuntimeError):
            settings.validate()
