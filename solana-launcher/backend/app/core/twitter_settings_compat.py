from __future__ import annotations

import os

from app.core.config import Settings


def install_x_api_settings_compat() -> None:
    """Expose legacy X settings without weakening the canonical Settings model.

    Current main deliberately owns the security-sensitive Settings schema. The
    Twitter stack historically referenced two optional X API fields directly.
    Until those fields are adopted by main, expose read-only descriptors backed
    by environment variables. If main later gains real model fields, this shim
    becomes a no-op automatically.
    """

    fields = getattr(Settings, "model_fields", {})
    if "x_api_bearer_token" not in fields:
        Settings.x_api_bearer_token = property(  # type: ignore[attr-defined]
            lambda _self: os.getenv("X_API_BEARER_TOKEN", "").strip()
        )
    if "x_api_base_url" not in fields:
        Settings.x_api_base_url = property(  # type: ignore[attr-defined]
            lambda _self: os.getenv("X_API_BASE_URL", "https://api.x.com/2").strip().rstrip("/")
        )
