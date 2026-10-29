"""Explicit local backend startup; --check validates configuration without DB/network writes."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=BACKEND / ".env")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    filename = args.env_file.resolve()
    if not filename.is_file():
        print(
            "Backend configuration file missing. Select the existing backend environment "
            "with --env-file; do not copy frontend credentials or create a replacement database.",
            file=sys.stderr,
        )
        return 2
    sys.path.insert(0, str(BACKEND))
    # Pin the same file for module-level Settings/get_settings during app import.
    os.environ["POTAPOFF_BACKEND_ENV_FILE"] = str(filename)
    from app.core.config import Settings
    from dotenv import dotenv_values, load_dotenv
    from pydantic import ValidationError

    values = dotenv_values(filename)
    # An accidental working-directory SQLite default would hide existing owners/vaults.
    if not (os.environ.get("DATABASE_URL") or values.get("DATABASE_URL")):
        print(
            "Backend configuration missing DATABASE_URL for the existing product database.",
            file=sys.stderr,
        )
        return 2
    try:
        Settings(_env_file=filename)
    except ValidationError as error:
        fields = sorted({".".join(map(str, item["loc"])) for item in error.errors()})
        print("Backend configuration invalid: " + ", ".join(fields), file=sys.stderr)
        return 2
    if args.check:
        print(
            "Backend configuration valid; no database connection, migration, account creation "
            "or server startup performed."
        )
        return 0
    # Keep process environment precedence consistent with Pydantic's validation.
    load_dotenv(filename, override=False)
    os.chdir(BACKEND)
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=args.port, reload=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
