#!/usr/bin/env python3
"""Dependency-free regression checks for high-risk full-repo security invariants."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


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

    dev_compose = read("memecoin-intelligence/docker-compose.yml")
    for port in ("3001:3001", "5173:5173"):
        secure = f'127.0.0.1:{port}'
        if secure not in dev_compose:
            failures.append(f"memecoin-intelligence dev port {port} is not loopback-bound")

    rss_client = read("intelligence/providers/rss/client.py")
    if "validate_outbound_public_http_url" not in rss_client:
        failures.append("RSS client does not validate resolved outbound hosts")
    if "_PublicOnlyRedirectHandler" not in rss_client:
        failures.append("RSS client does not revalidate redirect targets")

    url_security = read("intelligence/security/urls.py")
    if "socket.getaddrinfo" not in url_security or "address.is_global" not in url_security:
        failures.append("outbound URL validation does not verify resolved IP addresses")

    if failures:
        print("FULL_REPO_SECURITY_REGRESSION_FAILED", file=sys.stderr)
        for item in failures:
            print(f"- {item}", file=sys.stderr)
        return 1

    print("FULL_REPO_SECURITY_REGRESSION_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
