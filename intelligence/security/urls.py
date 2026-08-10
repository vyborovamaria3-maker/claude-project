"""Shared URL validation for external intelligence providers."""

from __future__ import annotations

import ipaddress
import urllib.parse


def validate_public_http_url(url: str) -> str:
    value = url.strip()
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Only http/https URLs are allowed")
    if not parsed.hostname:
        raise ValueError("URL must include a hostname")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("URL must not contain credentials")

    hostname = parsed.hostname.rstrip(".").lower()
    if hostname in {"localhost", "localhost.localdomain"} or hostname.endswith(".localhost"):
        raise ValueError("Localhost URLs are not allowed")

    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ValueError("Private, loopback and link-local IP URLs are not allowed")

    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("URL contains an invalid port") from exc
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("URL contains an invalid port")

    return urllib.parse.urlunsplit(
        (parsed.scheme.lower(), parsed.netloc, parsed.path or "/", parsed.query, "")
    )
