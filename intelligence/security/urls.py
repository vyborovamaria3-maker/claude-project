"""Shared URL validation for external intelligence providers."""

from __future__ import annotations

import ipaddress
import socket
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


def validate_outbound_public_http_url(url: str) -> str:
    """Validate a URL immediately before this process connects to it.

    Text-only URL checks are insufficient for SSRF protection because a normal
    hostname can resolve to loopback/private/link-local infrastructure. Resolve
    every address returned by DNS and require all of them to be globally routable.
    Callers that follow redirects must run this check on every redirect target too.
    """
    normalized = validate_public_http_url(url)
    parsed = urllib.parse.urlsplit(normalized)
    assert parsed.hostname is not None
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        addresses = socket.getaddrinfo(
            parsed.hostname,
            port,
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as exc:
        raise ValueError("URL hostname could not be resolved") from exc
    if not addresses:
        raise ValueError("URL hostname did not resolve to an address")

    for item in addresses:
        raw_address = item[4][0]
        try:
            address = ipaddress.ip_address(raw_address)
        except ValueError as exc:
            raise ValueError("URL resolved to an invalid IP address") from exc
        if not address.is_global:
            raise ValueError("URL hostname resolves to a non-public IP address")
    return normalized


def validate_public_url(url: str) -> str:
    """Backward-compatible name used by provider clients.

    Keep one implementation of the validation policy so providers cannot drift to
    weaker URL checks while older imports continue to work.
    """
    return validate_public_http_url(url)
