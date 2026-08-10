from __future__ import annotations

import hmac
import ipaddress
import os

from fastapi import Request

# Comma-separated list of trusted proxy IPs.
TRUSTED_PROXIES = {
    item.strip()
    for item in os.getenv("TRUSTED_PROXIES", "").split(",")
    if item.strip()
}


def _valid_ip(value: str | None) -> str | None:
    if not value:
        return None
    candidate = value.strip()
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return None


def _signed_frontend_ip(request: Request) -> str | None:
    settings = getattr(request.app.state, "settings", None)
    expected_key = getattr(settings, "backend_api_key", "") if settings else ""
    supplied_key = request.headers.get("x-potapoff-proxy-key", "")
    if not expected_key or not supplied_key:
        return None
    if not hmac.compare_digest(supplied_key.encode("utf-8"), expected_key.encode("utf-8")):
        return None
    return _valid_ip(request.headers.get("x-potapoff-client-ip"))


def get_client_ip(request: Request) -> str | None:
    """Resolve the real client IP without trusting browser-controlled forwarding headers."""
    signed_ip = _signed_frontend_ip(request)
    if signed_ip:
        return signed_ip

    client = request.client
    direct_ip = _valid_ip(client.host if client else None)
    if not direct_ip:
        return None

    if TRUSTED_PROXIES and direct_ip in TRUSTED_PROXIES:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            for item in forwarded.split(","):
                forwarded_ip = _valid_ip(item)
                if forwarded_ip:
                    return forwarded_ip

        real_ip = _valid_ip(request.headers.get("x-real-ip"))
        if real_ip:
            return real_ip

    return direct_ip
