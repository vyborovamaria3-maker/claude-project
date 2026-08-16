from __future__ import annotations

import os
import sys


def _workers() -> int:
    raw = os.getenv("ADMIN_WEB_WORKERS", "1").strip() or "1"
    try:
        value = int(raw)
    except ValueError as exc:
        raise SystemExit("ADMIN_WEB_WORKERS must be an integer") from exc
    if value < 1 or value > 8:
        raise SystemExit("ADMIN_WEB_WORKERS must be between 1 and 8")
    if value > 1 and not os.getenv("ADMIN_STATE_POSTGRES_DSN", "").strip():
        raise SystemExit("ADMIN_STATE_POSTGRES_DSN is required when ADMIN_WEB_WORKERS > 1")
    return value


def main() -> None:
    workers = _workers()
    os.execvp(
        "uvicorn",
        [
            "uvicorn",
            "app.main_admin:app",
            "--host",
            "0.0.0.0",
            "--port",
            "8080",
            "--workers",
            str(workers),
        ],
    )


if __name__ == "__main__":
    main()
