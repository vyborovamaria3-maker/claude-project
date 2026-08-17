import ipaddress
import os
import unittest
from unittest.mock import patch

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


class ProductionSecurityPolicyTests(unittest.TestCase):
    def test_production_accepts_strong_admin_policy(self) -> None:
        with patch.dict(os.environ, production_env(), clear=False):
            strong_settings().validate()

    def test_production_rejects_disabled_security_controls(self) -> None:
        for name in (
            "ADMIN_REQUIRE_NETWORK_ALLOWLIST",
            "ADMIN_REQUIRE_MFA",
            "ADMIN_REQUIRE_REAUTH",
            "ADMIN_SESSION_BIND_IP",
            "ADMIN_SESSION_BIND_USER_AGENT",
        ):
            with self.subTest(name=name):
                env = production_env()
                env[name] = "false"
                with patch.dict(os.environ, env, clear=False):
                    with self.assertRaises(RuntimeError):
                        strong_settings().validate()

    def test_production_rejects_plaintext_admin_password(self) -> None:
        settings = strong_settings()
        settings.admin_password_hash = ""
        settings.admin_password = "temporary-admin-password"
        with patch.dict(os.environ, production_env(), clear=False):
            with self.assertRaises(RuntimeError):
                settings.validate()


if __name__ == "__main__":
    unittest.main()
