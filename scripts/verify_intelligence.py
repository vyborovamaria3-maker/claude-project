#!/usr/bin/env python3
"""Reproducible verification entrypoint for the POTAPoff intelligence layer.

Run from any working directory:

    python3 scripts/verify_intelligence.py
    python3 scripts/verify_intelligence.py --full

The default profile is network-free and does not require Docker or PostgreSQL.
The full profile additionally requires Docker plus disposable PostgreSQL test DSNs.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Sequence


ROOT = Path(__file__).resolve().parents[1]
ADMIN = ROOT / "admin-site"
INTELLIGENCE = ROOT / "intelligence"

POSTGRES_DSN_ENV = "POTAPOFF_TEST_POSTGRES_DSN"
POSTGRES_READONLY_DSN_ENV = "POTAPOFF_TEST_POSTGRES_READONLY_DSN"


class VerificationError(RuntimeError):
    pass


def _run(command: Sequence[str], *, env: dict[str, str] | None = None) -> None:
    printable = " ".join(command)
    print(f"\n==> {printable}", flush=True)
    completed = subprocess.run(
        list(command),
        cwd=ROOT,
        env=env,
        check=False,
    )
    if completed.returncode != 0:
        raise VerificationError(f"verification command failed ({completed.returncode}): {printable}")


def _python(*args: str, env: dict[str, str] | None = None) -> None:
    _run((sys.executable, *args), env=env)


def _require_executable(name: str) -> None:
    if shutil.which(name) is None:
        raise VerificationError(f"required executable is not available: {name}")


def _verify_compile() -> None:
    _python("-m", "compileall", "-q", str(INTELLIGENCE))
    _python(
        "-m",
        "py_compile",
        str(ADMIN / "app/intelligence_view.py"),
        str(ADMIN / "app/intelligence_view_factory.py"),
        str(ADMIN / "app/main_admin.py"),
        str(ADMIN / "app/config.py"),
        str(ADMIN / "tests/test_intelligence_view.py"),
        str(ADMIN / "tests/test_intelligence_view_factory.py"),
    )


def _verify_unit_tests() -> None:
    _python("-m", "unittest", "discover", "-s", "intelligence/tests", "-p", "test_*.py", "-v")
    _python("-m", "intelligence", "backtest")

    env = os.environ.copy()
    env["PYTHONPATH"] = str(ADMIN)
    _python(
        "-m",
        "unittest",
        "discover",
        "-s",
        "admin-site/tests",
        "-p",
        "test_intelligence_*.py",
        "-v",
        env=env,
    )


def _verify_secret_templates() -> None:
    admin_template = (ADMIN / ".env.example").read_text(encoding="utf-8")
    worker_template = (ADMIN / ".env.intelligence.example").read_text(encoding="utf-8")

    if "POTAPOFF_INTELLIGENCE_POSTGRES_DSN=" in admin_template:
        raise VerificationError("worker write DSN must not exist in admin .env template")
    if "POTAPOFF_INTELLIGENCE_POSTGRES_DSN=" not in worker_template:
        raise VerificationError("worker .env template is missing POTAPOFF_INTELLIGENCE_POSTGRES_DSN")
    if "ADMIN_INTELLIGENCE_POSTGRES_DSN=" not in admin_template:
        raise VerificationError("admin .env template is missing ADMIN_INTELLIGENCE_POSTGRES_DSN")
    if "ADMIN_INTELLIGENCE_POSTGRES_DSN=" in worker_template:
        raise VerificationError("admin read-only DSN must not exist in worker .env template")


def _verify_credential_files() -> None:
    forbidden_names = {".env"}
    forbidden_suffixes = {".pem", ".key"}
    for path in INTELLIGENCE.rglob("*"):
        if not path.is_file():
            continue
        lower = path.name.lower()
        if (
            path.name in forbidden_names
            or path.suffix.lower() in forbidden_suffixes
            or "cookies" in lower
        ):
            raise VerificationError(f"credential-like file found under intelligence/: {path.relative_to(ROOT)}")


def _verify_postgres() -> None:
    writer = os.getenv(POSTGRES_DSN_ENV, "").strip()
    reader = os.getenv(POSTGRES_READONLY_DSN_ENV, "").strip()
    if not writer or not reader:
        raise VerificationError(
            f"--full requires both {POSTGRES_DSN_ENV} and {POSTGRES_READONLY_DSN_ENV}"
        )
    _python("-m", "unittest", "intelligence.tests.test_postgres_integration", "-v")


@contextmanager
def _compose_fixture_files() -> Iterator[None]:
    mappings = (
        (ADMIN / ".env.example", ADMIN / ".env"),
        (ADMIN / ".env.intelligence.example", ADMIN / ".env.intelligence"),
        (ADMIN / "sources.example.json", ADMIN / "sources.json"),
        (ADMIN / "logs.example.json", ADMIN / "logs.json"),
    )
    created: list[Path] = []
    try:
        for source, destination in mappings:
            if destination.exists():
                continue
            shutil.copyfile(source, destination)
            created.append(destination)
        yield
    finally:
        for path in reversed(created):
            try:
                path.unlink()
            except FileNotFoundError:
                pass


def _verify_compose_boundary() -> None:
    _require_executable("docker")
    compose = ("docker", "compose", "-f", "admin-site/docker-compose.yml")
    _run((*compose, "config", "--quiet"))
    result = subprocess.run(
        [*compose, "config", "--format", "json"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise VerificationError("docker compose config --format json failed")
    try:
        config = json.loads(result.stdout)
        services = config["services"]
        admin_env = services["admin"].get("environment", {})
        worker_env = services["intelligence-worker"].get("environment", {})
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise VerificationError("rendered Docker Compose configuration has unexpected shape") from exc

    if "POTAPOFF_INTELLIGENCE_POSTGRES_DSN" in admin_env:
        raise VerificationError("rendered admin service contains worker PostgreSQL DSN")
    if "ADMIN_INTELLIGENCE_POSTGRES_DSN" in worker_env:
        raise VerificationError("rendered worker service contains admin PostgreSQL DSN")
    if "POTAPOFF_INTELLIGENCE_POSTGRES_DSN" not in worker_env:
        raise VerificationError("rendered worker service is missing its PostgreSQL DSN key")
    if "ADMIN_INTELLIGENCE_POSTGRES_DSN" not in admin_env:
        raise VerificationError("rendered admin service is missing its read-only PostgreSQL DSN key")


def _verify_worker_image(tag: str) -> None:
    _require_executable("docker")
    _run(("docker", "build", "--pull", "-t", tag, "intelligence"))

    inspect = subprocess.run(
        ["docker", "image", "inspect", tag, "--format", "{{.Config.User}}"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if inspect.returncode != 0 or inspect.stdout.strip() != "intelligence":
        raise VerificationError("worker image must run as the intelligence user")

    base = (
        "docker",
        "run",
        "--rm",
        "--read-only",
        "--tmpfs",
        "/tmp:size=256m",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        tag,
    )
    _run((*base, "python", "-m", "intelligence", "--help"))
    _run((*base, "python", "-m", "intelligence", "backtest"))
    _run((*base, "yt-dlp", "--version"))
    _run((*base, "deno", "--version"))


def run(profile: str, image_tag: str) -> None:
    print(f"POTAPoff intelligence verification profile: {profile}")
    _verify_compile()
    _verify_unit_tests()
    _verify_secret_templates()
    _verify_credential_files()

    if profile == "full":
        _verify_postgres()
        with _compose_fixture_files():
            _verify_compose_boundary()
        _verify_worker_image(image_tag)

    print("\nVERIFICATION PASSED", flush=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--full",
        action="store_true",
        help="also run live PostgreSQL, Docker Compose and worker-image checks",
    )
    parser.add_argument(
        "--image-tag",
        default="potapoff-intelligence:verify",
        help="worker image tag used by the full profile",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        run("full" if args.full else "core", args.image_tag)
        return 0
    except (OSError, VerificationError) as exc:
        print(f"VERIFICATION FAILED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
