from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_superuser
from app.cli.twitter_discovery_cycle import build_parser as build_cycle_parser
from app.cli.twitter_discovery_cycle import run_configured as run_cycle_configured
from app.db.session import get_db
from app.models.twitter_crawler_run import TwitterCrawlerRun
from app.models.twitter_crawler_settings import TwitterCrawlerSettings
from app.models.twitter_intelligence import (
    TwitterAccount,
    TwitterDiscoveryCandidate,
    TwitterDiscoveryEvidence,
    TwitterPost,
)
from app.services.twitter_discovery import ResolvedTwitterProfile, promote_candidate
from app.services.twitter_discovery_scoring import rescore_discovery_candidates

router = APIRouter(dependencies=[Depends(get_current_superuser)])


class LegacyConfigPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    discovery_enabled: bool | None = None
    dexscreener_enabled: bool | None = None
    coinmarketcap_enabled: bool | None = None
    seed_discovery_enabled: bool | None = None
    public_web_enabled: bool | None = None
    x_api_enrichment_enabled: bool | None = None
    cmc_limit: int | None = Field(default=None, ge=0, le=5000)
    rescore_limit: int | None = Field(default=None, ge=0, le=5000)
    process_limit: int | None = Field(default=None, ge=1, le=5000)
    network_limit: int | None = Field(default=None, ge=1, le=1000)
    max_depth: int | None = Field(default=None, ge=0, le=8)
    min_relevance: float | None = Field(default=None, ge=0.0, le=100.0, allow_inf_nan=False)
    batch_size: int | None = Field(default=None, ge=1, le=250)


async def _settings_for_update(session: AsyncSession) -> TwitterCrawlerSettings:
    row = (
        await session.execute(
            select(TwitterCrawlerSettings).where(TwitterCrawlerSettings.id == 1).with_for_update()
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Twitter crawler settings are not initialized",
        )
    return row


def _legacy_config(row: TwitterCrawlerSettings, *, x_api_configured: bool) -> dict[str, Any]:
    return {
        "discovery_enabled": bool(row.enabled or row.public_enabled),
        "dexscreener_enabled": bool(row.public_dexscreener_latest or row.public_dexscreener_boosts),
        "coinmarketcap_enabled": int(row.public_cmc_limit) > 0,
        "seed_discovery_enabled": bool(row.enabled),
        "public_web_enabled": bool(row.public_enabled),
        "x_api_enrichment_enabled": bool(row.enabled and x_api_configured),
        "cmc_limit": int(row.public_cmc_limit),
        "rescore_limit": int(row.rescore_limit),
        "process_limit": int(row.process_limit),
        "network_limit": int(row.network_limit),
        "max_depth": int(row.max_depth),
        "min_relevance": float(row.min_relevance),
        "batch_size": int(row.batch_size),
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "updated_by": "canonical_crawler_settings",
    }


def _summary_int(summary: object, *path: str) -> int:
    current = summary
    for key in path:
        if not isinstance(current, dict):
            return 0
        current = current.get(key)
    if current is None:
        return 0
    if not isinstance(current, int | float | str):
        return 0
    try:
        return int(current)
    except (TypeError, ValueError):
        return 0


def _run_item(row: TwitterCrawlerRun) -> dict[str, Any]:
    summary = row.summary or {}
    meta = row.meta or {}
    candidates_created = (
        _summary_int(summary, "seed_discovered")
        + _summary_int(summary, "public_web_discovered")
        + _summary_int(summary, "x_search_discovered")
        + _summary_int(summary, "dexscreener_latest")
        + _summary_int(summary, "dexscreener_boosts")
        + _summary_int(summary, "dexscreener_db_tokens")
        + _summary_int(summary, "cmc_keyless")
    )
    frontier = summary.get("frontier") if isinstance(summary, dict) else None
    if isinstance(frontier, dict) and isinstance(frontier.get("frontier"), dict):
        frontier = frontier["frontier"]
    promoted = _summary_int(frontier, "accepted")
    failed = _summary_int(frontier, "failed") + _summary_int(frontier, "rate_limited")
    return {
        "id": row.id,
        "started_at": row.started_at.isoformat() if row.started_at else None,
        "finished_at": row.finished_at.isoformat() if row.finished_at else None,
        "status": "completed" if row.status == "success" else row.status,
        "worker_id": row.worker,
        "mode": str(meta.get("mode") or row.job_name),
        "trigger": str(meta.get("trigger") or "daemon"),
        "candidates_created": candidates_created,
        "evidence_created": _summary_int(summary, "evidence_created"),
        "rescored": _summary_int(summary, "rescore", "rescored")
        + _summary_int(summary, "rescore_after_frontier", "rescored"),
        "promoted": promoted,
        "skipped": int(bool(isinstance(summary, dict) and summary.get("skipped"))),
        "failed": failed,
        "error": row.error,
    }


@router.get("/overview")
async def overview(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    candidate_rows = (
        await session.execute(
            select(
                TwitterDiscoveryCandidate.status, func.count(TwitterDiscoveryCandidate.id)
            ).group_by(TwitterDiscoveryCandidate.status)
        )
    ).all()
    candidate_status_counts = {str(key): int(value) for key, value in candidate_rows}
    total_accounts = int(
        (await session.execute(select(func.count(TwitterAccount.id)))).scalar_one() or 0
    )
    total_evidence = int(
        (await session.execute(select(func.count(TwitterDiscoveryEvidence.id)))).scalar_one() or 0
    )
    total_posts = int((await session.execute(select(func.count(TwitterPost.id)))).scalar_one() or 0)

    run_rows = list(
        (
            await session.execute(
                select(TwitterCrawlerRun)
                .where(
                    TwitterCrawlerRun.job_name.in_(
                        ("twitter_discovery_cycle", "twitter_discovery_public")
                    )
                )
                .order_by(TwitterCrawlerRun.started_at.desc(), TwitterCrawlerRun.id.desc())
                .limit(100)
            )
        )
        .scalars()
        .all()
    )
    last_run = run_rows[0] if run_rows else None
    last_success = next((row for row in run_rows if row.status == "success"), None)
    last_failed = next((row for row in run_rows if row.status == "failed"), None)

    latest_candidate = (
        await session.execute(
            select(TwitterDiscoveryCandidate)
            .order_by(TwitterDiscoveryCandidate.first_seen_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    latest_evidence = (
        await session.execute(
            select(TwitterDiscoveryEvidence)
            .order_by(TwitterDiscoveryEvidence.observed_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    latest_promoted = (
        await session.execute(
            select(TwitterDiscoveryCandidate)
            .where(TwitterDiscoveryCandidate.status == "accepted")
            .order_by(TwitterDiscoveryCandidate.last_seen_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    crawler_settings = await session.get(TwitterCrawlerSettings, 1)

    current_status = "idle"
    if last_run and last_run.status == "running":
        current_status = "running"
    elif last_run and last_run.status in {"failed", "degraded"}:
        current_status = last_run.status
    elif crawler_settings is not None and not (
        crawler_settings.enabled or crawler_settings.public_enabled
    ):
        current_status = "disabled"

    x_api_configured = bool(request.app.state.settings.x_api_bearer_token.strip())
    return {
        "status": current_status,
        "x_api_configured": x_api_configured,
        "mode": "x_api" if x_api_configured else "public_no_x_api",
        "total_candidates": sum(candidate_status_counts.values()),
        "candidate_status_counts": candidate_status_counts,
        "total_accounts": total_accounts,
        "total_evidence": total_evidence,
        "total_posts": total_posts,
        "last_run": last_run.started_at.isoformat() if last_run else None,
        "last_successful_run": last_success.started_at.isoformat() if last_success else None,
        "last_failed_run": last_failed.started_at.isoformat() if last_failed else None,
        "last_new_candidate": latest_candidate.first_seen_at.isoformat()
        if latest_candidate
        else None,
        "last_new_evidence": latest_evidence.observed_at.isoformat() if latest_evidence else None,
        "last_promoted_account": latest_promoted.last_seen_at.isoformat()
        if latest_promoted
        else None,
        "last_run_duration_seconds": (
            float(last_run.duration_ms) / 1000.0
            if last_run and last_run.duration_ms is not None
            else None
        ),
        "worker_id": last_run.worker if last_run else None,
    }


@router.get("/runs")
async def runs(
    limit: int = Query(default=20, ge=1, le=100),
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    rows = list(
        (
            await session.execute(
                select(TwitterCrawlerRun)
                .where(
                    TwitterCrawlerRun.job_name.in_(
                        ("twitter_discovery_cycle", "twitter_discovery_public")
                    )
                )
                .order_by(TwitterCrawlerRun.started_at.desc(), TwitterCrawlerRun.id.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return {"items": [_run_item(row) for row in rows]}


@router.get("/config")
async def get_config(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    row = await session.get(TwitterCrawlerSettings, 1)
    if row is None:
        raise HTTPException(status_code=503, detail="Twitter crawler settings are missing")
    return _legacy_config(
        row,
        x_api_configured=bool(request.app.state.settings.x_api_bearer_token.strip()),
    )


@router.patch("/config")
async def patch_config(
    payload: LegacyConfigPatch,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    changes = payload.model_dump(exclude_none=True)
    if not changes:
        return {"status": "success", "config": await get_config(request, session)}

    row = await _settings_for_update(session)
    if "discovery_enabled" in changes:
        row.enabled = bool(changes["discovery_enabled"])
        row.public_enabled = bool(changes["discovery_enabled"])
    if "dexscreener_enabled" in changes:
        value = bool(changes["dexscreener_enabled"])
        row.public_dexscreener_latest = value
        row.public_dexscreener_boosts = value
    if "coinmarketcap_enabled" in changes:
        if changes["coinmarketcap_enabled"]:
            if row.public_cmc_limit <= 0:
                row.public_cmc_limit = 50
        else:
            row.public_cmc_limit = 0
    if "seed_discovery_enabled" in changes:
        row.enabled = bool(changes["seed_discovery_enabled"])
    if "public_web_enabled" in changes:
        row.public_enabled = bool(changes["public_web_enabled"])
    if "x_api_enrichment_enabled" in changes:
        row.enabled = bool(changes["x_api_enrichment_enabled"])
    if "cmc_limit" in changes:
        row.public_cmc_limit = int(changes["cmc_limit"])
    if "rescore_limit" in changes:
        row.rescore_limit = max(1, int(changes["rescore_limit"]))
        row.public_rescore_limit = int(changes["rescore_limit"])
    for field in (
        "process_limit",
        "network_limit",
        "max_depth",
        "min_relevance",
        "batch_size",
    ):
        if field in changes:
            setattr(row, field, changes[field])

    await session.commit()
    await session.refresh(row)
    return {
        "status": "success",
        "config": _legacy_config(
            row,
            x_api_configured=bool(request.app.state.settings.x_api_bearer_token.strip()),
        ),
    }


@router.post("/actions/run")
async def run_now(
    _payload: dict[str, Any] | None = None,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    running = (
        await session.execute(
            select(TwitterCrawlerRun.id)
            .where(
                TwitterCrawlerRun.status == "running",
                TwitterCrawlerRun.job_name.in_(
                    ("twitter_discovery_cycle", "twitter_discovery_public")
                ),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if running is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A Twitter discovery run is already in progress",
        )

    args = build_cycle_parser().parse_args([])
    result = await run_cycle_configured(args, [])
    if result.get("skipped") is True and result.get("reason") == "already_running":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A Twitter discovery run is already in progress",
        )
    return {"status": "success", "summary": result}


@router.post("/actions/rescore")
async def rescore_now(session: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    settings = await session.get(TwitterCrawlerSettings, 1)
    limit = int(settings.rescore_limit) if settings is not None else 1500
    stats = await rescore_discovery_candidates(session, limit=limit)
    await session.commit()
    return {"status": "success", "stats": stats}


@router.post("/actions/candidates/{candidate_id}/promote")
async def promote_now(
    candidate_id: int,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    candidate = (
        await session.execute(
            select(TwitterDiscoveryCandidate)
            .where(TwitterDiscoveryCandidate.id == candidate_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if candidate is None:
        raise HTTPException(status_code=404, detail="Candidate not found")
    if candidate.account_id is not None:
        raise HTTPException(status_code=400, detail="Candidate is already promoted")
    if not candidate.twitter_id:
        raise HTTPException(
            status_code=400,
            detail="Stable X user ID is required for canonical promotion",
        )

    profile_meta = (candidate.meta or {}).get("resolved_profile")
    if not isinstance(profile_meta, dict) or not profile_meta.get("twitter_id"):
        raise HTTPException(status_code=400, detail="Resolved profile metadata is missing")

    profile = ResolvedTwitterProfile(
        twitter_id=str(profile_meta["twitter_id"]),
        username=profile_meta.get("username"),
        display_name=profile_meta.get("display_name"),
        bio=str(profile_meta.get("bio") or ""),
        avatar_url=profile_meta.get("avatar_url"),
        followers_count=int(profile_meta.get("followers_count") or 0),
        following_count=int(profile_meta.get("following_count") or 0),
        tweet_count=int(profile_meta.get("tweet_count") or 0),
        verified=bool(profile_meta.get("verified")),
        source=str(profile_meta.get("source") or "admin_manual"),
        raw=profile_meta.get("raw"),
    )
    settings = await session.get(TwitterCrawlerSettings, 1)
    min_relevance = float(settings.min_relevance) if settings is not None else 35.0
    accepted, account_id, relevance = await promote_candidate(
        session,
        candidate,
        profile,
        min_relevance=min_relevance,
    )
    await session.commit()
    return {
        "status": "success",
        "accepted": accepted,
        "account_id": account_id,
        "relevance_score": relevance,
    }
