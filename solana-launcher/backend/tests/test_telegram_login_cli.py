from __future__ import annotations

from pathlib import Path

from app.cli import telegram_login


def test_telegram_login_credentials_do_not_load_full_app_settings(
    monkeypatch,
    tmp_path: Path,
) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text(
        "TG_API_ID=123456\n"
        f"TG_API_HASH={'a' * 32}\n"
        "ENVIRONMENT=production\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(telegram_login, "_BACKEND_ENV", env_path)
    monkeypatch.delenv("TG_API_ID", raising=False)
    monkeypatch.delenv("TG_API_HASH", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("SECRET_KEY", raising=False)
    monkeypatch.delenv("SUBSCRIPTION_PASSWORD_ENCRYPTION_KEY", raising=False)

    api_id, api_hash, prompted = telegram_login._resolve_api_credentials()

    assert api_id == 123456
    assert api_hash == "a" * 32
    assert prompted is False


def test_telegram_login_repairs_concatenated_credentials(
    monkeypatch,
    tmp_path: Path,
) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text(
        f"TG_API_ID=123456TG_API_HASH={'a' * 32}\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(telegram_login, "_BACKEND_ENV", env_path)
    monkeypatch.delenv("TG_API_ID", raising=False)
    monkeypatch.delenv("TG_API_HASH", raising=False)
    monkeypatch.setattr("builtins.input", lambda _prompt: "123456")
    monkeypatch.setattr(telegram_login.getpass, "getpass", lambda _prompt: "b" * 32)

    api_id, api_hash, prompted = telegram_login._resolve_api_credentials()

    assert api_id == 123456
    assert api_hash == "b" * 32
    assert prompted is True

    telegram_login._write_env_value(env_path, "TG_API_ID", str(api_id))
    telegram_login._write_env_value(env_path, "TG_API_HASH", api_hash)

    rows = env_path.read_text(encoding="utf-8").splitlines()
    assert rows.count("TG_API_ID=123456") == 1
    assert rows.count(f"TG_API_HASH={'b' * 32}") == 1
    assert not any("TG_API_ID=123456TG_API_HASH=" in row for row in rows)
