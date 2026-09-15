from __future__ import annotations

import argparse
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_superuser
from app.cli.twitter_discovery import run as run_discovery_cli_sync
from app.core.config import Settings
from app.db.session import get_db
from app.models.twitter_discovery_admin import TwitterDiscoveryConfig, TwitterDiscoveryRun
from app.models.twitter_discovery_scoring import TwitterDiscoveryScore
from app.models.twitter_intelligence import (
    TwitterAccount,
    TwitterAccountScore,
    TwitterAccountSnapshot,
    TwitterAccountTokenStat,
    TwitterDiscoveryCandidate,
    TwitterDiscoveryEvidence,
    TwitterPost,
)
from app.services.twitter_discovery import (
    ResolvedTwitterProfile,
    promote_candidate,
)
from app.services.twitter_discovery_scoring import (
    rescore_discovery_candidates,
)

router = APIRouter(dependencies=[Depends(get_current_superuser)])


def utcnow() -> datetime:
    return datetime.now(UTC)


def _x_api_bearer_token(settings: Settings) -> str:
    return str(getattr(settings, "x_api_bearer_token", "")).strip()


async def _get_or_create_config(session: AsyncSession) -> TwitterDiscoveryConfig:
    config = (await session.execute(select(TwitterDiscoveryConfig))).scalar_one_or_none()
    if config is None:
        config = TwitterDiscoveryConfig()
        session.add(config)
        await session.flush()
    return config


def _get_settings(request: Request) -> Settings:
    return request.app.state.settings


@router.get("/overview")
async def get_twitter_registry_overview(
    session: AsyncSession = Depends(get_db),
    settings: Settings = Depends(_get_settings),
) -> dict[str, Any]:
    # Stats counts
    status_counts_rows = (
        await session.execute(
            select(
                TwitterDiscoveryCandidate.status,
                func.count(TwitterDiscoveryCandidate.id),
            ).group_by(TwitterDiscoveryCandidate.status)
        )
    ).all()
    candidate_status_counts = {str(st): int(cnt) for st, cnt in status_counts_rows}
    total_candidates = sum(candidate_status_counts.values())

    total_accounts = (
        await session.execute(select(func.count(TwitterAccount.id)))
    ).scalar_one() or 0
    total_evidence = (
        await session.execute(select(func.count(TwitterDiscoveryEvidence.id)))
    ).scalar_one() or 0
    total_posts = (await session.execute(select(func.count(TwitterPost.id)))).scalar_one() or 0

    # Last runs
    last_run = (
        await session.execute(
            select(TwitterDiscoveryRun).order_by(TwitterDiscoveryRun.started_at.desc()).limit(1)
        )
    ).scalar_one_or_none()

    last_success = (
        await session.execute(
            select(TwitterDiscoveryRun)
            .where(TwitterDiscoveryRun.status == "completed")
            .order_by(TwitterDiscoveryRun.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    last_failed = (
        await session.execute(
            select(TwitterDiscoveryRun)
            .where(TwitterDiscoveryRun.status == "failed")
            .order_by(TwitterDiscoveryRun.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

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

    config = await _get_or_create_config(session)
    x_api_configured = bool(_x_api_bearer_token(settings))

    discovery_status = "idle"
    if last_run and last_run.status == "running":
        discovery_status = "running"
    elif last_failed and (not last_success or last_failed.started_at > last_success.started_at):
        discovery_status = "failed"
    elif not config.discovery_enabled:
        discovery_status = "disabled"

    return {
        "status": discovery_status,
        "x_api_configured": x_api_configured,
        "mode": "x_api" if x_api_configured else "public_no_x_api",
        "total_candidates": total_candidates,
        "candidate_status_counts": candidate_status_counts,
        "total_accounts": total_accounts,
        "total_evidence": total_evidence,
        "total_posts": total_posts,
        "last_run": last_run.started_at.isoformat() if last_run and last_run.started_at else None,
        "last_successful_run": last_success.started_at.isoformat()
        if last_success and last_success.started_at
        else None,
        "last_failed_run": last_failed.started_at.isoformat()
        if last_failed and last_failed.started_at
        else None,
        "last_new_candidate": latest_candidate.first_seen_at.isoformat()
        if latest_candidate
        else None,
        "last_new_evidence": latest_evidence.observed_at.isoformat() if latest_evidence else None,
        "last_promoted_account": latest_promoted.last_seen_at.isoformat()
        if latest_promoted
        else None,
        "last_run_duration_seconds": (
            (last_run.finished_at - last_run.started_at).total_seconds()
            if last_run and last_run.finished_at and last_run.started_at
            else None
        ),
        "worker_id": last_run.worker_id if last_run else None,
    }


@router.get("/candidates")
async def list_candidates(
    session: AsyncSession = Depends(get_db),
    status: str | None = Query(default=None),
    source: str | None = Query(default=None),
    search: str | None = Query(default=None),
    min_score: float | None = Query(default=None),
    promoted: bool | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    sort_by: str = Query(default="first_seen"),
    order: str = Query(default="desc"),
) -> dict[str, Any]:
    stmt = select(TwitterDiscoveryCandidate, TwitterDiscoveryScore).outerjoin(
        TwitterDiscoveryScore, TwitterDiscoveryScore.candidate_id == TwitterDiscoveryCandidate.id
    )

    if status:
        stmt = stmt.where(TwitterDiscoveryCandidate.status == status)
    if search:
        pattern = f"%{search.strip().lower()}%"
        stmt = stmt.where(
            func.lower(TwitterDiscoveryCandidate.username).like(pattern)
            | func.lower(TwitterDiscoveryCandidate.display_name).like(pattern)
            | func.lower(TwitterDiscoveryCandidate.candidate_key).like(pattern)
        )
    if promoted is True:
        stmt = stmt.where(TwitterDiscoveryCandidate.account_id.is_not(None))
    elif promoted is False:
        stmt = stmt.where(TwitterDiscoveryCandidate.account_id.is_(None))

    if min_score is not None:
        stmt = stmt.where(TwitterDiscoveryScore.discovery_score >= min_score)

    # Counting total
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await session.execute(count_stmt)).scalar_one() or 0

    # Sorting
    if sort_by == "score":
        sort_col: Any = TwitterDiscoveryScore.discovery_score
    elif sort_by == "confidence":
        sort_col = TwitterDiscoveryScore.confidence
    elif sort_by == "last_seen":
        sort_col = TwitterDiscoveryCandidate.last_seen_at
    elif sort_by == "priority":
        sort_col = TwitterDiscoveryCandidate.priority
    else:
        sort_col = TwitterDiscoveryCandidate.first_seen_at

    if order == "asc":
        stmt = stmt.order_by(sort_col.asc())
    else:
        stmt = stmt.order_by(sort_col.desc())

    stmt = stmt.limit(limit).offset(offset)
    rows = (await session.execute(stmt)).all()

    items = []
    for candidate, score in rows:
        items.append(
            {
                "id": candidate.id,
                "candidate_key": candidate.candidate_key,
                "twitter_id": candidate.twitter_id,
                "username": candidate.username,
                "display_name": candidate.display_name,
                "status": candidate.status,
                "priority": candidate.priority,
                "depth": candidate.depth,
                "relevance_hint": candidate.relevance_hint,
                "account_id": candidate.account_id,
                "attempts": candidate.attempts,
                "last_error": candidate.last_error,
                "first_seen_at": candidate.first_seen_at.isoformat()
                if candidate.first_seen_at
                else None,
                "last_seen_at": candidate.last_seen_at.isoformat()
                if candidate.last_seen_at
                else None,
                "discovery_score": score.discovery_score if score else 0.0,
                "confidence": score.confidence if score else 0.0,
                "promotion_ready": bool(candidate.twitter_id and candidate.status != "accepted"),
            }
        )

    return {
        "items": items,
        "meta": {"total": total, "limit": limit, "offset": offset},
    }


@router.get("/candidates/{candidate_id}")
async def get_candidate_detail(
    candidate_id: int,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    candidate = await session.get(TwitterDiscoveryCandidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Candidate not found")

    score = await session.get(TwitterDiscoveryScore, candidate_id)
    evidence_rows = (
        (
            await session.execute(
                select(TwitterDiscoveryEvidence)
                .where(TwitterDiscoveryEvidence.candidate_id == candidate_id)
                .order_by(TwitterDiscoveryEvidence.observed_at.desc())
            )
        )
        .scalars()
        .all()
    )

    canonical_account = None
    if candidate.account_id:
        canonical_account = await session.get(TwitterAccount, candidate.account_id)

    return {
        "candidate": {
            "id": candidate.id,
            "candidate_key": candidate.candidate_key,
            "twitter_id": candidate.twitter_id,
            "username": candidate.username,
            "display_name": candidate.display_name,
            "account_type_hint": candidate.account_type_hint,
            "status": candidate.status,
            "priority": candidate.priority,
            "depth": candidate.depth,
            "relevance_hint": candidate.relevance_hint,
            "account_id": candidate.account_id,
            "parent_account_id": candidate.parent_account_id,
            "attempts": candidate.attempts,
            "lease_owner": candidate.lease_owner,
            "lease_expires_at": candidate.lease_expires_at.isoformat()
            if candidate.lease_expires_at
            else None,
            "last_attempt_at": candidate.last_attempt_at.isoformat()
            if candidate.last_attempt_at
            else None,
            "next_attempt_at": candidate.next_attempt_at.isoformat()
            if candidate.next_attempt_at
            else None,
            "last_error": candidate.last_error,
            "first_seen_at": candidate.first_seen_at.isoformat()
            if candidate.first_seen_at
            else None,
            "last_seen_at": candidate.last_seen_at.isoformat() if candidate.last_seen_at else None,
            "meta": candidate.meta,
        },
        "score": {
            "discovery_score": score.discovery_score if score else 0.0,
            "confidence": score.confidence if score else 0.0,
            "relevance_score": score.relevance_score if score else 0.0,
            "source_score": score.source_score if score else 0.0,
            "graph_score": score.graph_score if score else 0.0,
            "engagement_score": score.engagement_score if score else 0.0,
            "early_signal_score": score.early_signal_score if score else 0.0,
            "recency_score": score.recency_score if score else 0.0,
            "evidence_count": score.evidence_count if score else 0.0,
            "score_version": score.score_version if score else None,
            "scored_at": score.scored_at.isoformat() if score and score.scored_at else None,
            "components": score.components if score else None,
        }
        if score
        else None,
        "evidence": [
            {
                "id": ev.id,
                "source_type": ev.source_type,
                "source_ref": ev.source_ref,
                "discovery_reason": ev.discovery_reason,
                "query": ev.query,
                "source_url": ev.source_url,
                "observed_at": ev.observed_at.isoformat() if ev.observed_at else None,
                "raw": ev.raw,
            }
            for ev in evidence_rows
        ],
        "canonical_account": {
            "id": canonical_account.id,
            "twitter_id": canonical_account.twitter_id,
            "username": canonical_account.username,
            "display_name": canonical_account.display_name,
            "status": canonical_account.status,
            "followers_count": canonical_account.followers_count,
            "following_count": canonical_account.following_count,
            "tweet_count": canonical_account.tweet_count,
            "verified": canonical_account.verified,
        }
        if canonical_account
        else None,
    }


@router.get("/accounts")
async def list_accounts(
    session: AsyncSession = Depends(get_db),
    status: str | None = Query(default=None),
    account_type: str | None = Query(default=None),
    search: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    stmt = select(TwitterAccount)
    if status:
        stmt = stmt.where(TwitterAccount.status == status)
    if account_type:
        stmt = stmt.where(TwitterAccount.account_type == account_type)
    if search:
        pattern = f"%{search.strip().lower()}%"
        stmt = stmt.where(
            func.lower(TwitterAccount.username).like(pattern)
            | func.lower(TwitterAccount.display_name).like(pattern)
            | func.lower(TwitterAccount.twitter_id).like(pattern)
        )

    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await session.execute(count_stmt)).scalar_one() or 0

    stmt = stmt.order_by(TwitterAccount.last_seen_at.desc()).limit(limit).offset(offset)
    accounts = (await session.execute(stmt)).scalars().all()

    items = []
    for acc in accounts:
        score = await session.get(TwitterAccountScore, acc.id)
        items.append(
            {
                "id": acc.id,
                "twitter_id": acc.twitter_id,
                "username": acc.username,
                "display_name": acc.display_name,
                "account_type": acc.account_type,
                "status": acc.status,
                "followers_count": acc.followers_count,
                "following_count": acc.following_count,
                "tweet_count": acc.tweet_count,
                "verified": acc.verified,
                "source": acc.source,
                "first_seen_at": acc.first_seen_at.isoformat() if acc.first_seen_at else None,
                "last_seen_at": acc.last_seen_at.isoformat() if acc.last_seen_at else None,
                "alpha_score": score.alpha_score if score else 0.0,
                "trust_score": score.trust_score if score else 0.0,
                "influence_score": score.influence_score if score else 0.0,
            }
        )

    return {
        "items": items,
        "meta": {"total": total, "limit": limit, "offset": offset},
    }


@router.get("/accounts/{account_id}")
async def get_account_detail(
    account_id: int,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    account = await session.get(TwitterAccount, account_id)
    if not account:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")

    score = await session.get(TwitterAccountScore, account_id)
    snapshots = list(
        (
            await session.execute(
                select(TwitterAccountSnapshot)
                .where(TwitterAccountSnapshot.account_id == account_id)
                .order_by(TwitterAccountSnapshot.captured_at.desc())
                .limit(20)
            )
        )
        .scalars()
        .all()
    )

    posts = (
        (
            await session.execute(
                select(TwitterPost)
                .where(TwitterPost.account_id == account_id)
                .order_by(TwitterPost.published_at.desc())
                .limit(20)
            )
        )
        .scalars()
        .all()
    )

    token_stats = (
        (
            await session.execute(
                select(TwitterAccountTokenStat)
                .where(TwitterAccountTokenStat.account_id == account_id)
                .order_by(TwitterAccountTokenStat.token_alpha_score.desc())
                .limit(20)
            )
        )
        .scalars()
        .all()
    )

    return {
        "account": {
            "id": account.id,
            "twitter_id": account.twitter_id,
            "username": account.username,
            "display_name": account.display_name,
            "bio": account.bio,
            "avatar_url": account.avatar_url,
            "followers_count": account.followers_count,
            "following_count": account.following_count,
            "tweet_count": account.tweet_count,
            "verified": account.verified,
            "x_created_at": account.x_created_at.isoformat() if account.x_created_at else None,
            "account_type": account.account_type,
            "status": account.status,
            "source": account.source,
            "first_seen_at": account.first_seen_at.isoformat() if account.first_seen_at else None,
            "last_seen_at": account.last_seen_at.isoformat() if account.last_seen_at else None,
            "last_profile_sync_at": account.last_profile_sync_at.isoformat()
            if account.last_profile_sync_at
            else None,
            "raw": account.raw,
        },
        "score": {
            "influence_score": score.influence_score if score else 0.0,
            "trust_score": score.trust_score if score else 0.0,
            "alpha_score": score.alpha_score if score else 0.0,
            "shill_score": score.shill_score if score else 0.0,
            "bot_score": score.bot_score if score else 0.0,
            "crypto_relevance_score": score.crypto_relevance_score if score else 0.0,
            "solana_relevance_score": score.solana_relevance_score if score else 0.0,
            "score_confidence": score.score_confidence if score else 0.0,
            "score_source": score.score_source if score else "unknown",
            "model_version": score.model_version if score else None,
            "updated_at": score.updated_at.isoformat() if score and score.updated_at else None,
        }
        if score
        else None,
        "snapshots_count": len(snapshots) if isinstance(snapshots, list) else 0,
        "posts_count": len(posts),
        "token_stats_count": len(token_stats),
    }


@router.get("/evidence")
async def list_evidence(
    session: AsyncSession = Depends(get_db),
    candidate_id: int | None = Query(default=None),
    source_type: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    stmt = select(TwitterDiscoveryEvidence)
    if candidate_id:
        stmt = stmt.where(TwitterDiscoveryEvidence.candidate_id == candidate_id)
    if source_type:
        stmt = stmt.where(TwitterDiscoveryEvidence.source_type == source_type)

    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await session.execute(count_stmt)).scalar_one() or 0

    stmt = stmt.order_by(TwitterDiscoveryEvidence.observed_at.desc()).limit(limit).offset(offset)
    rows = (await session.execute(stmt)).scalars().all()

    items = [
        {
            "id": ev.id,
            "candidate_id": ev.candidate_id,
            "source_type": ev.source_type,
            "source_ref": ev.source_ref,
            "discovery_reason": ev.discovery_reason,
            "query": ev.query,
            "source_url": ev.source_url,
            "observed_at": ev.observed_at.isoformat() if ev.observed_at else None,
            "raw": ev.raw,
        }
        for ev in rows
    ]
    return {"items": items, "meta": {"total": total, "limit": limit, "offset": offset}}


@router.get("/runs")
async def list_discovery_runs(
    session: AsyncSession = Depends(get_db),
    limit: int = Query(default=20, ge=1, le=100),
) -> dict[str, Any]:
    runs = (
        (
            await session.execute(
                select(TwitterDiscoveryRun)
                .order_by(TwitterDiscoveryRun.started_at.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )

    items = [
        {
            "id": r.id,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
            "status": r.status,
            "worker_id": r.worker_id,
            "mode": r.mode,
            "trigger": r.trigger,
            "candidates_created": r.candidates_created,
            "evidence_created": r.evidence_created,
            "rescored": r.rescored,
            "promoted": r.promoted,
            "skipped": r.skipped,
            "failed": r.failed,
            "error": r.error,
        }
        for r in runs
    ]
    return {"items": items}


@router.get("/config")
async def get_discovery_config(session: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    config = await _get_or_create_config(session)
    return {
        "discovery_enabled": config.discovery_enabled,
        "dexscreener_enabled": config.dexscreener_enabled,
        "coinmarketcap_enabled": config.coinmarketcap_enabled,
        "seed_discovery_enabled": config.seed_discovery_enabled,
        "public_web_enabled": config.public_web_enabled,
        "x_api_enrichment_enabled": config.x_api_enrichment_enabled,
        "cmc_limit": config.cmc_limit,
        "rescore_limit": config.rescore_limit,
        "process_limit": config.process_limit,
        "network_limit": config.network_limit,
        "max_depth": config.max_depth,
        "min_relevance": config.min_relevance,
        "batch_size": config.batch_size,
        "updated_at": config.updated_at.isoformat() if config.updated_at else None,
        "updated_by": config.updated_by,
    }


@router.patch("/config")
async def update_discovery_config(
    payload: dict[str, Any],
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    config = await _get_or_create_config(session)
    allowed_fields = {
        "discovery_enabled",
        "dexscreener_enabled",
        "coinmarketcap_enabled",
        "seed_discovery_enabled",
        "public_web_enabled",
        "x_api_enrichment_enabled",
        "cmc_limit",
        "rescore_limit",
        "process_limit",
        "network_limit",
        "max_depth",
        "min_relevance",
        "batch_size",
    }
    for field, value in payload.items():
        if field in allowed_fields:
            setattr(config, field, value)

    config.updated_at = utcnow()
    await session.commit()
    await session.refresh(config)
    return {"status": "success", "config": await get_discovery_config(session)}


@router.post("/actions/run")
async def action_run_discovery(
    payload: dict[str, Any] | None = None,
    session: AsyncSession = Depends(get_db),
    settings: Settings = Depends(_get_settings),
) -> dict[str, Any]:
    payload = payload or {}
    trigger = str(payload.get("trigger", "admin_manual"))
    config = await _get_or_create_config(session)
    if not config.discovery_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Twitter discovery is disabled in settings",
        )

    # Check for concurrent running
    running = (
        await session.execute(
            select(TwitterDiscoveryRun).where(TwitterDiscoveryRun.status == "running").limit(1)
        )
    ).scalar_one_or_none()
    if running:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="A discovery run is already in progress"
        )

    run_record = TwitterDiscoveryRun(
        status="running",
        mode="x_api" if _x_api_bearer_token(settings) else "public_no_x_api",
        trigger=trigger,
        config_snapshot={
            "process_limit": config.process_limit,
            "min_relevance": config.min_relevance,
        },
    )
    session.add(run_record)
    await session.commit()
    await session.refresh(run_record)

    try:
        # Build args for discovery CLI runner
        args = argparse.Namespace(
            seed_file="data/twitter-discovery/crypto_media_seeds.json",
            queries_file="data/twitter-discovery/queries.json",
            public_url=[],
            skip_seeds=not config.seed_discovery_enabled,
            skip_x_search=not _x_api_bearer_token(settings),
            skip_frontier=False,
            query_limit=config.cmc_limit,
            process_limit=config.process_limit,
            batch_size=config.batch_size,
            max_depth=config.max_depth,
            min_relevance=config.min_relevance,
            network_mode="following",
            network_limit=config.network_limit,
            lease_seconds=300,
            worker_id=f"admin-api:{run_record.id}",
            dry_run=False,
        )

        summary = await run_discovery_cli_sync(args)
        run_record.status = "completed"
        run_record.finished_at = utcnow()
        run_record.candidates_created = int(
            summary.get("seed_discovered", 0)
            + summary.get("public_web_discovered", 0)
            + summary.get("x_search_discovered", 0)
        )
        run_record.promoted = int(summary.get("frontier", {}).get("accepted", 0))
        run_record.failed = int(summary.get("frontier", {}).get("failed", 0))
        await session.commit()
        return {"status": "success", "run_id": run_record.id, "summary": summary}
    except Exception as exc:
        run_record.status = "failed"
        run_record.finished_at = utcnow()
        run_record.error = str(exc)[:4000]
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Discovery run failed: {exc}"
        ) from exc


@router.post("/actions/rescore")
async def action_rescore(session: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    config = await _get_or_create_config(session)
    stats = await rescore_discovery_candidates(session, limit=config.rescore_limit)
    await session.commit()
    return {"status": "success", "stats": stats}


@router.post("/actions/candidates/{candidate_id}/promote")
async def action_promote_candidate(
    candidate_id: int,
    session: AsyncSession = Depends(get_db),
    settings: Settings = Depends(lambda req: req.app.state.settings),
) -> dict[str, Any]:
    candidate = await session.get(TwitterDiscoveryCandidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Candidate not found")
    if candidate.account_id is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Candidate is already promoted to canonical account",
        )
    if not candidate.twitter_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Stable X user ID unavailable. Candidate can be discovered and scored, "
                "but canonical promotion requires reliable twitter_id resolution."
            ),
        )

    profile_meta = (candidate.meta or {}).get("resolved_profile")
    if not isinstance(profile_meta, dict) or not profile_meta.get("twitter_id"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Resolved profile metadata missing for candidate",
        )

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

    config = await _get_or_create_config(session)
    accepted, account_id, relevance = await promote_candidate(
        session,
        candidate,
        profile,
        min_relevance=config.min_relevance,
    )
    await session.commit()
    return {
        "status": "success",
        "accepted": accepted,
        "account_id": account_id,
        "relevance_score": relevance,
    }
