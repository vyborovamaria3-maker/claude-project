from __future__ import annotations

import ipaddress
import os
from decimal import Decimal
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator

from .auth import require_admin


class SubscriptionSettingsBody(BaseModel):
    monthly_price_sol: Decimal = Field(ge=0, max_digits=20, decimal_places=9)
    monthly_price_usdt: Decimal = Field(ge=0, max_digits=20, decimal_places=6)
    free_demo_enabled: bool
    demo_days: int = Field(ge=1, le=3650)
    solana_recipient_wallet: str = Field(default="", max_length=64)

    @field_validator("solana_recipient_wallet")
    @classmethod
    def normalize_wallet(cls, value: str) -> str:
        return (value or "").strip()


def _backend_config() -> tuple[str, str]:
    base_url = os.getenv("POTAPOFF_BACKEND_URL", "http://backend:8000").strip().rstrip("/")
    api_key = os.getenv("POTAPOFF_SUBSCRIPTION_ADMIN_KEY", "").strip()
    if not base_url:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Subscription backend URL is not configured",
        )
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Subscription backend access is not configured",
        )
    return base_url, api_key


async def _backend_request(method: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    base_url, api_key = _backend_config()
    url = f"{base_url}/api/v1/subscriptions/settings"
    timeout = httpx.Timeout(8.0, connect=3.0)

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.request(
                method,
                url,
                headers={"X-API-Key": api_key},
                json=payload,
            )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Subscription backend is unavailable",
        ) from exc

    try:
        body = response.json()
    except ValueError:
        body = {}

    if response.is_error:
        detail = body.get("detail") if isinstance(body, dict) else None
        if response.status_code == status.HTTP_403_FORBIDDEN:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Subscription backend access is not configured correctly",
            )
        if response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=detail or "Subscription settings are invalid",
            )
        if response.status_code >= 500:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Subscription backend failed to update settings",
            )
        raise HTTPException(
            status_code=response.status_code,
            detail=detail or "Subscription backend rejected the request",
        )

    if not isinstance(body, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Subscription backend returned an invalid response",
        )
    return body


def _request_ip(request: Request) -> str | None:
    settings = request.app.state.settings
    direct = request.client.host if request.client else None
    if not direct or not settings.trust_proxy:
        return direct
    values = [
        item.strip()
        for item in request.headers.get("x-forwarded-for", "").split(",")
        if item.strip()
    ]
    if not values:
        return direct
    index = len(values) - settings.trusted_proxy_hops - 1
    if index < 0:
        return direct
    candidate = values[index]
    try:
        ipaddress.ip_address(candidate)
        return candidate
    except ValueError:
        return direct


def build_subscription_admin_router() -> APIRouter:
    router = APIRouter(prefix="/api/subscription-settings", tags=["subscription-admin"])

    @router.get("")
    async def read_subscription_settings(admin=Depends(require_admin)) -> dict[str, Any]:
        del admin
        return await _backend_request("GET")

    @router.put("")
    async def update_subscription_settings(
        body: SubscriptionSettingsBody,
        request: Request,
        admin=Depends(require_admin),
    ) -> dict[str, Any]:
        payload = body.model_dump(mode="json")
        try:
            updated = await _backend_request("PUT", payload)
        except HTTPException as exc:
            request.app.state.audit.record(
                action="subscription_settings_update",
                success=False,
                username=admin["sub"],
                ip_address=_request_ip(request),
                resource="miniapp.subscription_settings",
                details={"status_code": exc.status_code},
            )
            raise

        request.app.state.audit.record(
            action="subscription_settings_update",
            success=True,
            username=admin["sub"],
            ip_address=_request_ip(request),
            resource="miniapp.subscription_settings",
            details={
                "free_demo_enabled": updated.get("free_demo_enabled"),
                "demo_days": updated.get("demo_days"),
                "recipient_configured": bool(updated.get("solana_recipient_wallet")),
                "monthly_price_sol": updated.get("monthly_price_sol"),
                "monthly_price_usdt": updated.get("monthly_price_usdt"),
            },
        )
        return updated

    return router
