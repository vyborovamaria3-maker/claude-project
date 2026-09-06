#!/usr/bin/env python3
"""Dependency-free regression checks for high-risk full-repo security invariants."""

from __future__ import annotations

import importlib.util
import re
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def check_secret_scan_behavior(failures: list[str]) -> None:
    scanner_path = ROOT / "security/audit/secret-scan.py"
    spec = importlib.util.spec_from_file_location("repo_secret_scan", scanner_path)
    if spec is None or spec.loader is None:
        failures.append("could not load secret-scan.py for regression verification")
        return
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

    fake_jwt = "eyJabcdefghij.abcdefghijk.abcdefghijk"

    findings: set[tuple[str, str]] = set()
    # A placeholder elsewhere on the line must not suppress a real JWT match.
    module.scan_line("fixture.txt", f"YOUR_TOKEN example only; leaked={fake_jwt}", findings)
    if ("fixture.txt", "jwt-bearer") not in findings:
        failures.append("secret scanner can still be bypassed by placeholder text on the same line")

    # Tracked source archives are part of the repository attack surface too.
    with tempfile.TemporaryDirectory() as tmp:
        archive_path = Path(tmp) / "fixture.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr("src/config.ts", f"export const leaked = '{fake_jwt}';\n")
        archive_findings: set[tuple[str, str]] = set()
        module.scan_zip_file("fixture.zip", archive_path, archive_findings)
        if ("fixture.zip!/src/config.ts", "jwt-bearer") not in archive_findings:
            failures.append("secret scanner does not inspect text files inside tracked ZIP archives")


def main() -> int:
    failures: list[str] = []

    candle = read("pumpfun-chart/backend/candle-aggregator.js")
    if JWT_RE.search(candle):
        failures.append("pumpfun-chart contains a JWT-like credential")
    if not candle.lstrip().startswith("/**"):
        failures.append("pumpfun-chart candle aggregator has unexpected content before its header")

    mcp_solana = read("mcp-servers/src/solana-server.ts")
    if "response.url" in mcp_solana:
        failures.append("MCP Helius error path includes response.url and may expose api-key query parameters")
    if "redactHeliusSecrets" not in mcp_solana:
        failures.append("MCP Helius error redaction helper is missing")

    memecoin_compose = read("memecoin-intelligence/docker-compose.yml")
    for port in ("3001:3001", "5173:5173"):
        secure = f"127.0.0.1:{port}"
        if secure not in memecoin_compose:
            failures.append(f"memecoin-intelligence dev port {port} is not loopback-bound")

    subscription_compose = read("solana-subscription-service/docker-compose.yml")
    for port in ("5433:5432", "6380:6379", "4000:4000", "3000:3000", "4040:4040"):
        secure = f"127.0.0.1:{port}"
        if secure not in subscription_compose:
            failures.append(f"solana-subscription-service dev port {port} is not loopback-bound")
    if "REDIS_PASSWORD:?REDIS_PASSWORD is required" not in subscription_compose:
        failures.append("subscription dev Compose does not fail closed on a missing Redis password")
    if "--requirepass" not in subscription_compose:
        failures.append("subscription dev Redis authentication is not enforced")
    if "POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required" not in subscription_compose:
        failures.append("subscription dev Compose does not fail closed on a missing Postgres password")

    rss_client = read("intelligence/providers/rss/client.py")
    if "validate_outbound_public_http_url" not in rss_client:
        failures.append("RSS client does not validate resolved outbound hosts")
    if "_PublicOnlyRedirectHandler" not in rss_client:
        failures.append("RSS client does not revalidate redirect targets")

    url_security = read("intelligence/security/urls.py")
    if "socket.getaddrinfo" not in url_security or "address.is_global" not in url_security:
        failures.append("outbound URL validation does not verify resolved IP addresses")

    check_secret_scan_behavior(failures)

    if failures:
        print("FULL_REPO_SECURITY_REGRESSION_FAILED", file=sys.stderr)
        for item in failures:
            print(f"- {item}", file=sys.stderr)
        return 1

    print("FULL_REPO_SECURITY_REGRESSION_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
