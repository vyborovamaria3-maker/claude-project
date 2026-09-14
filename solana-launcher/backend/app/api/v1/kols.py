from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_subscriber
from app.db.session import get_db
from app.models.analytics import Wallet
from app.models.kol_intelligence import (
    KOLProfile,
    KOLSourceSync,
    KOLWalletAttribution,
    KOLWalletEvidence,
    KOLWalletMetric,
)
from app.services.kol_intelligence import (
    build_kol_token_intelligence,
    related_wallet_candidates,
)
from app.services.telegram_parser import is_solana_address

router = APIRouter()


class KOLSyncRequest(BaseModel):
    items: list[dict[str, Any]] = Field(default_factory=list, max_length=500)
    sourceStatus: list[dict[str, Any]] = Field(default_factory=list, max_length=100)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _require_backend_key(request: Request, supplied: str | None) -> None:
    expected = request.app.state.settings.backend_api_key
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="BACKEND_API_KEY is not configured",
        )
    if not supplied or not hmac.compare_digest(supplied, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid backend API key",
        )


def _clean_handle(value: Any) -> str:
    handle = str(value or "").strip().lstrip("@").lower()
    if not handle or len(handle) > 64 or not all(char.isalnum() or char == "_" for char in handle):
        raise ValueError("invalid twitter handle")
    return handle


def _float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed and abs(parsed) != float("inf") else None


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _evidence_fingerprint(row: dict[str, Any]) -> str:
    source = str(row.get("source") or "")
    kind = str(row.get("kind") or "")
    detail = str(row.get("detail") or "")
    url = str(row.get("url") or "")
    return hashlib.sha256(f"{source}|{kind}|{detail}|{url}".encode()).hexdigest()


def _serialize_profile(profile: KOLProfile) -> dict[str, Any]:
    return {
        "id": profile.id,
        "handle": profile.twitter_handle,
        "name": profile.display_name or f"@{profile.twitter_handle}",
        "avatar": profile.avatar_url,
        "twitterUrl": profile.twitter_url,
        "telegramUrl": profile.telegram_url,
        "confidence": profile.confidence,
        "verified": profile.verified,
        "sources": (profile.source_meta or {}).get("sources", []),
        "updatedAt": profile.updated_at.isoformat() if profile.updated_at else None,
        "wallets": [
            {
                "id": wallet.id,
                "address": wallet.address,
                "chain": wallet.chain,
                "confidence": wallet.confidence,
                "verified": wallet.verified,
                "analyticsWalletId": wallet.analytics_wallet_id,
                "firstSeenAt": wallet.first_seen_at.isoformat() if wallet.first_seen_at else None,
                "lastSeenAt": wallet.last_seen_at.isoformat() if wallet.last_seen_at else None,
                "evidence": [
                    {
                        "source": evidence.source,
                        "kind": evidence.kind,
                        "confidence": evidence.confidence,
                        "verified": evidence.verified,
                        "detail": evidence.detail,
                        "url": evidence.source_url,
                        "observedAt": evidence.observed_at.isoformat() if evidence.observed_at else None,
                    }
                    for evidence in wallet.evidence
                ],
                "metrics": [
                    {
                        "timeframeDays": metric.timeframe_days,
                        "source": metric.source,
                        "pnlValue": metric.pnl_value,
                        "pnlCurrency": metric.pnl_currency,
                        "realizedPnlUsd": metric.realized_pnl_usd,
                        "unrealizedPnlUsd": metric.unrealized_pnl_usd,
                        "winRate": metric.win_rate,
                        "wins": metric.wins,
                        "losses": metric.losses,
                        "volumeUsd": metric.volume_usd,
                        "tradeCount": metric.trade_count,
                        "lastTradeAt": metric.last_trade_at.isoformat() if metric.last_trade_at else None,
                        "calculatedAt": metric.calculated_at.isoformat() if metric.calculated_at else None,
                    }
                    for metric in wallet.metrics
                ],
            }
            for wallet in profile.wallets
        ],
    }


def _profile_options():
    return (
        selectinload(KOLProfile.wallets).selectinload(KOLWalletAttribution.evidence),
        selectinload(KOLProfile.wallets).selectinload(KOLWalletAttribution.metrics),
    )


@router.get("")
async def list_kols(
    q: str | None = Query(default=None, max_length=128),
    verified_only: bool = Query(default=False),
    min_confidence: float = Query(default=0, ge=0, le=100),
    limit: int = Query(default=100, ge=1, le=500),
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_subscriber),
) -> dict[str, Any]:
    del current_user
    stmt = select(KOLProfile).options(*_profile_options())
    if q:
        value = q.strip().lstrip("@").lower()
        if value:
            stmt = stmt.where(
                or_(
                    KOLProfile.twitter_handle.ilike(f"%{value}%"),
                    KOLProfile.display_name.ilike(f"%{value}%"),
                    KOLProfile.wallets.any(KOLWalletAttribution.address.ilike(f"%{value}%")),
                )
            )
    if verified_only:
        stmt = stmt.where(KOLProfile.verified.is_(True))
    if min_confidence:
        stmt = stmt.where(KOLProfile.confidence >= min_confidence)
    rows = list(
        (
            await session.execute(
                stmt.order_by(KOLProfile.confidence.desc(), KOLProfile.updated_at.desc()).limit(limit)
            )
        ).scalars().unique().all()
    )
    return {"items": [_serialize_profile(item) for item in rows], "total": len(rows)}


@router.get("/source-health")
async def source_health(
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_subscriber),
) -> dict[str, Any]:
    del current_user
    rows = list(
        (
            await session.execute(
                select(KOLSourceSync).order_by(KOLSourceSync.source.asc())
            )
        ).scalars().all()
    )
    return {
        "items": [
            {
                "source": row.source,
                "status": row.status,
                "recordsSeen": row.records_seen,
                "detail": row.detail,
                "lastSuccessAt": row.last_success_at.isoformat() if row.last_success_at else None,
                "lastErrorAt": row.last_error_at.isoformat() if row.last_error_at else None,
                "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
            }
            for row in rows
        ]
    }


@router.get("/token/{mint_address}")
async def token_kol_intelligence(
    mint_address: str,
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_subscriber),
) -> dict[str, Any]:
    del current_user
    if not is_solana_address(mint_address):
        raise HTTPException(status_code=400, detail="Invalid Solana mint address")
    return await build_kol_token_intelligence(session, mint_address)


@router.get("/{handle}")
async def get_kol(
    handle: str,
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_subscriber),
) -> dict[str, Any]:
    del current_user
    normalized = _clean_handle(handle)
    profile = (
        await session.execute(
            select(KOLProfile)
            .options(*_profile_options())
            .where(KOLProfile.twitter_handle == normalized)
            .limit(1)
        )
    ).scalar_one_or_none()
    if profile is None:
        raise HTTPException(status_code=404, detail="KOL not found")
    return _serialize_profile(profile)


@router.get("/{handle}/related")
async def get_related_wallets(
    handle: str,
    limit: int = Query(default=20, ge=1, le=100),
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_subscriber),
) -> dict[str, Any]:
    del current_user
    normalized = _clean_handle(handle)
    profile = (
        await session.execute(
            select(KOLProfile)
            .options(selectinload(KOLProfile.wallets))
            .where(KOLProfile.twitter_handle == normalized)
            .limit(1)
        )
    ).scalar_one_or_none()
    if profile is None:
        raise HTTPException(status_code=404, detail="KOL not found")

    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for wallet in profile.wallets:
        if wallet.chain != "solana":
            continue
        for candidate in await related_wallet_candidates(session, wallet.address, limit=limit):
            address = str(candidate.get("address") or "")
            if not address or address in seen:
                continue
            seen.add(address)
            items.append({"sourceWallet": wallet.address, **candidate})
            if len(items) >= limit:
                break
        if len(items) >= limit:
            break
    return {
        "handle": normalized,
        "items": items,
        "classification": "possible_related_wallets",
        "ownershipClaim": False,
    }


@router.post("/sync")
async def sync_kols(
    payload: KOLSyncRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
    x_backend_api_key: str | None = Header(default=None, alias="X-Backend-API-Key"),
) -> dict[str, Any]:
    _require_backend_key(request, x_backend_api_key)
    now = utcnow()
    synced_profiles = 0
    synced_wallets = 0

    for raw_profile in payload.items:
        try:
            handle = _clean_handle(raw_profile.get("handle"))
        except ValueError:
            continue
        profile = (
            await session.execute(
                select(KOLProfile).where(KOLProfile.twitter_handle == handle).limit(1)
            )
        ).scalar_one_or_none()
        if profile is None:
            profile = KOLProfile(twitter_handle=handle)
            session.add(profile)
            await session.flush()

        profile.display_name = str(raw_profile.get("name") or "")[:255] or profile.display_name
        profile.avatar_url = str(raw_profile.get("avatar") or "")[:1024] or None
        profile.twitter_url = str(raw_profile.get("twitterUrl") or f"https://x.com/{handle}")[:512]
        profile.telegram_url = str(raw_profile.get("telegramUrl") or "")[:512] or None
        profile.confidence = max(0.0, min(100.0, _float(raw_profile.get("confidence")) or 0.0))
        profile.verified = bool(raw_profile.get("verified"))
        profile.source_meta = {"sources": [str(item)[:120] for item in raw_profile.get("sources") or []][:50]}
        profile.updated_at = now
        synced_profiles += 1

        for raw_wallet in raw_profile.get("wallets") or []:
            address = str(raw_wallet.get("address") or "").strip()
            chain = str(raw_wallet.get("chain") or "").strip().lower()
            if not address or chain not in {"solana", "ethereum"} or len(address) > 128:
                continue
            attribution = (
                await session.execute(
                    select(KOLWalletAttribution).where(
                        KOLWalletAttribution.kol_id == profile.id,
                        KOLWalletAttribution.chain == chain,
                        KOLWalletAttribution.address == address,
                    ).limit(1)
                )
            ).scalar_one_or_none()
            if attribution is None:
                attribution = KOLWalletAttribution(
                    kol_id=profile.id,
                    address=address,
                    chain=chain,
                    first_seen_at=now,
                )
                session.add(attribution)
                await session.flush()

            attribution.confidence = max(0.0, min(100.0, _float(raw_wallet.get("confidence")) or 0.0))
            attribution.verified = bool(raw_wallet.get("verified"))
            attribution.last_seen_at = now
            evidences = [item for item in raw_wallet.get("evidence") or [] if isinstance(item, dict)]
            attribution.source_count = len({str(item.get("source") or "") for item in evidences if item.get("source")})

            if chain == "solana" and is_solana_address(address):
                analytics_wallet = (
                    await session.execute(
                        select(Wallet).where(Wallet.wallet_address == address).limit(1)
                    )
                ).scalar_one_or_none()
                if analytics_wallet is None:
                    analytics_wallet = Wallet(
                        wallet_address=address,
                        first_seen_date=now,
                        tags=["kol"],
                    )
                    session.add(analytics_wallet)
                    await session.flush()
                elif "kol" not in (analytics_wallet.tags or []):
                    analytics_wallet.tags = [*(analytics_wallet.tags or []), "kol"]
                attribution.analytics_wallet_id = analytics_wallet.id

            await session.flush()
            for raw_evidence in evidences:
                source = str(raw_evidence.get("source") or "unknown")[:120]
                kind = str(raw_evidence.get("kind") or "curated_label")[:64]
                fingerprint = _evidence_fingerprint(raw_evidence)
                evidence = (
                    await session.execute(
                        select(KOLWalletEvidence).where(
                            KOLWalletEvidence.wallet_id == attribution.id,
                            KOLWalletEvidence.source == source,
                            KOLWalletEvidence.kind == kind,
                            KOLWalletEvidence.fingerprint == fingerprint,
                        ).limit(1)
                    )
                ).scalar_one_or_none()
                if evidence is None:
                    evidence = KOLWalletEvidence(
                        wallet_id=attribution.id,
                        source=source,
                        kind=kind,
                        fingerprint=fingerprint,
                    )
                    session.add(evidence)
                evidence.confidence = max(0.0, min(100.0, _float(raw_evidence.get("confidence")) or 0.0))
                evidence.verified = bool(raw_evidence.get("verified"))
                evidence.detail = str(raw_evidence.get("detail") or "")[:1000] or None
                evidence.source_url = str(raw_evidence.get("url") or "")[:1024] or None
                evidence.raw_payload = raw_evidence
                evidence.observed_at = now

            raw_metrics = raw_wallet.get("metrics") or {}
            if isinstance(raw_metrics, dict):
                for days, key in ((1, "pnl1dSol"), (7, "pnl7dSol"), (30, "pnl30dSol")):
                    pnl = _float(raw_metrics.get(key))
                    wins = _int(raw_metrics.get("wins"))
                    losses = _int(raw_metrics.get("losses"))
                    win_rate = _float(raw_metrics.get("winRate"))
                    if pnl is None and wins is None and losses is None and win_rate is None:
                        continue
                    metric = (
                        await session.execute(
                            select(KOLWalletMetric).where(
                                KOLWalletMetric.wallet_id == attribution.id,
                                KOLWalletMetric.timeframe_days == days,
                                KOLWalletMetric.source == "resolver",
                            ).limit(1)
                        )
                    ).scalar_one_or_none()
                    if metric is None:
                        metric = KOLWalletMetric(
                            wallet_id=attribution.id,
                            timeframe_days=days,
                            source="resolver",
                        )
                        session.add(metric)
                    metric.pnl_value = pnl
                    metric.pnl_currency = "SOL" if pnl is not None else None
                    metric.wins = wins
                    metric.losses = losses
                    metric.win_rate = win_rate
                    metric.trade_count = (wins + losses) if wins is not None and losses is not None else None
                    metric.raw_payload = raw_metrics
                    metric.calculated_at = now
            synced_wallets += 1

    for raw_status in payload.sourceStatus:
        source = str(raw_status.get("source") or "")[:120]
        if not source:
            continue
        row = (
            await session.execute(
                select(KOLSourceSync).where(KOLSourceSync.source == source).limit(1)
            )
        ).scalar_one_or_none()
        if row is None:
            row = KOLSourceSync(source=source)
            session.add(row)
        ok = bool(raw_status.get("ok"))
        row.status = "ok" if ok else "error"
        row.detail = str(raw_status.get("detail") or "")[:1000] or None
        row.records_seen = synced_profiles
        row.updated_at = now
        if ok:
            row.last_success_at = now
        else:
            row.last_error_at = now

    await session.commit()
    return {"ok": True, "profiles": synced_profiles, "wallets": synced_wallets}
