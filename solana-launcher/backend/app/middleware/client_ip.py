from __future__ import annotations

import os
from fastapi import Request

# Comma-separated list of trusted proxy IPs
TRUSTED_PROXIES = set(
    os.getenv("TRUSTED_PROXIES", "").split(",")
    if os.getenv("TRUSTED_PROXIES")
    else []
)


def get_client_ip(request: Request) -> str | None:
    """
    Get client IP address with protection against X-Forwarded-For spoofing.
    
    Only trusts X-Forwarded-For header when the immediate connection
    is from a trusted proxy. This prevents clients from spoofing their IP
    by sending fake X-Forwarded-For headers directly to the server.
    """
    client = request.client
    direct_ip = client.host if client else None
    
    # If we have no direct IP, we can't determine the client
    if not direct_ip:
        return None
    
    # Only check X-Forwarded-For if connected through a trusted proxy
    if TRUSTED_PROXIES and direct_ip in TRUSTED_PROXIES:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            # X-Forwarded-For can contain multiple IPs: client, proxy1, proxy2, ...
            # The first IP is the original client
            # The last IP before our proxy is the one we want
            ips = [ip.strip() for ip in forwarded.split(",")]
            # Return the first non-empty IP
            for ip in ips:
                if ip:
                    return ip
    
    # Also check X-Real-IP header if from trusted proxy
    if TRUSTED_PROXIES and direct_ip in TRUSTED_PROXIES:
        real_ip = request.headers.get("x-real-ip")
        if real_ip:
            return real_ip.strip()
    
    # Return the direct connection IP (not from headers)
    return direct_ip
