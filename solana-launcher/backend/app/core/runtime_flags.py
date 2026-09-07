from __future__ import annotations

import os


def telegram_runtime_in_api() -> bool:
    """Keep the legacy in-process runtime for direct development only.

    Production/container deployments should run the dedicated Telegram runtime
    process so API replicas never start duplicate collectors. The flag remains
    explicitly overrideable for diagnostics.
    """
    explicit = os.getenv("TG_RUNTIME_IN_API")
    if explicit is not None:
        return explicit.strip().lower() in {"1", "true", "yes", "on"}
    environment = os.getenv("ENVIRONMENT", "development").strip().lower()
    return environment not in {"production", "prod"}
