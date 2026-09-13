from __future__ import annotations

from argparse import Namespace
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import exists, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_superuser
from app.cli.twitter_discovery import run as run_registry_discovery
from app.cli.twitter_discovery_public import run as run_public_discovery
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
from app.models.user import User
from app.schemas.twitter_registry_admin import (
    TwitterDiscoveryConfigPatch,
    TwitterDiscoveryRunRequest,
)
from app.services.twitter_discovery import profile_from_meta, promote_candidate
from app.services.twitter_discovery_admin_runtime import (
    DiscoveryRunBusy,
    fail_discovery_run,
    finish_discovery_run,
    recover_stale_discovery_runs,
    start_discovery_run,
    touch_discovery_run,
)
from app.services.twitter_discovery_scoring import rescore_discovery_candidates

router = APIRouter(dependencies=[Depends(get_current_superuser)])


def utcnow() -> datetime:
    return datetime.now(UTC)


def _get_settings(request: Request) -> Settings:
    return request.app.state.settings


async def _get_or_create_config(session: AsyncSession) -> TwitterDiscoveryConfig:
    config = await session.get(TwitterDiscoveryConfig, 1)
    if config is not None:
        return config
    try:
        async with session.begin_nested():
            config = TwitterDiscoveryConfig(id=1)
            session.add(config)
            await session.flush()
        return config
    except IntegrityError:
        config = await session.get(TwitterDiscoveryConfig, 1)
        if config is None:
            raise
        return config


def _config_payload(config: TwitterDiscoveryConfig) -> dict[str, Any]:
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


def _safe_config_snapshot(config: TwitterDiscoveryConfig) -> dict[str, Any]:
    return {
        key: value
        for key, value in _config_payload(config).items()
        if key not in {"updated_at", "updated_by"}
    }


async def _scalar_count(session: AsyncSession, stmt: Any) -> int:
    return int((await session.execute(stmt)).scalar_one() or 0)


def _evidence_source_condition(source: str) -> Any:
    normalized = source.strip().lower()
    if normalized == "dexscreener":
        return (
            (TwitterDiscoveryEvidence.source_type == "public_web")
            & func.lower(TwitterDiscoveryEvidence.source_ref).like("dexscreener%")
        )
    if normalized == "coinmarketcap":
        return (
            (TwitterDiscoveryEvidence.source_type == "public_web")
            & or_(
                func.lower(TwitterDiscoveryEvidence.source_ref).like("coinmarketcap%"),
                func.lower(TwitterDiscoveryEvidence.source_ref).like("cmc%"),
            )
        )
    return TwitterDiscoveryEvidence.source_type == source


async def _window_metrics(session: AsyncSession, since: datetime) -> dict[str, Any]:
    new_candidates = await _scalar_count(
        session,
        select(func.count(TwitterDiscoveryCandidate.id)).where(
            TwitterDiscoveryCandidate.first_seen_at >= since
        ),
    )
    new_evidence = await _scalar_count(
        session,
        select(func.count(TwitterDiscoveryEvidence.id)).where(
            TwitterDiscoveryEvidence.observed_at >= since
        ),
    )
    new_accounts = await _scalar_count(
        session,
        select(func.count(TwitterAccount.id)).where(TwitterAccount.first_seen_at >= since),
    )
    new_posts = await _scalar_count(
        session,
        select(func.count(TwitterPost.id)).where(TwitterPost.created_at >= since),
    )
    completed_runs = await _scalar_count(
        session,
        select(func.count(TwitterDiscoveryRun.id)).where(
            TwitterDiscoveryRun.status == "completed",
            TwitterDiscoveryRun.finished_at >= since,
        ),
    )
    failed_runs = await _scalar_count(
        session,
        select(func.count(TwitterDiscoveryRun.id)).where(
            TwitterDiscoveryRun.status == "failed",
            TwitterDiscoveryRun.finished_at >= since,
        ),
    )
    sums = (
        await session.execute(
            select(
                func.coalesce(func.sum(TwitterDiscoveryRun.promoted), 0),
                func.coalesce(func.sum(TwitterDiscoveryRun.rescored), 0),
                func.coalesce(func.sum(TwitterDiscoveryRun.skipped), 0),
            ).where(TwitterDiscoveryRun.finished_at >= since)
        )
    ).one()

    source_rows = (
        await session.execute(
            select(
                TwitterDiscoveryEvidence.source_type,
                func.count(TwitterDiscoveryEvidence.id),
            )
            .where(TwitterDiscoveryEvidence.observed_at >= since)
            .group_by(TwitterDiscoveryEvidence.source_type)
        )
    ).all()
    source_breakdown = {str(source): int(count) for source, count in source_rows}
    dexscreener = await _scalar_count(
        session,
        select(func.count(TwitterDiscoveryEvidence.id)).where(
            TwitterDiscoveryEvidence.observed_at >= since,
            TwitterDiscoveryEvidence.source_type == "public_web",
            func.lower(TwitterDiscoveryEvidence.source_ref).like("dexscreener%"),
        ),
    )
    coinmarketcap = await _scalar_count(
        session,
        select(func.count(TwitterDiscoveryEvidence.id)).where(
            TwitterDiscoveryEvidence.observed_at >= since,
            TwitterDiscoveryEvidence.source_type == "public_web",
            or_(
                func.lower(TwitterDiscoveryEvidence.source_ref).like("coinmarketcap%"),
                func.lower(TwitterDiscoveryEvidence.source_ref).like("cmc%"),
            ),
        ),
    )
    source_breakdown["dexscreener"] = dexscreener
    source_breakdown["coinmarketcap"] = coinmarketcap

    return {
        "new_candidates": new_candidates,
        "new_evidence": new_evidence,
        "new_canonical_accounts": new_accounts,
        "new_posts": new_posts,
        "completed_runs": completed_runs,
        "failed_runs": failed_runs,
        "promoted": int(sums[0] or 0),
        "rescored": int(sums[1] or 0),
        "skipped": int(sums[2] or 0),
        "source_breakdown": source_breakdown,
    }


@router.get("/overview")
async def get_twitter_registry_overview(
    session: AsyncSession = Depends(get_db),
    settings: Settings = Depends(_get_settings),
) -> dict[str, Any]:
    await recover_stale_discovery_runs(session)
    config = await _get_or_create_config(session)

    status_counts_rows = (
        await session.execute(
            select(
                TwitterDiscoveryCandidate.status,
                func.count(TwitterDiscoveryCandidate.id),
            ).group_by(TwitterDiscoveryCandidate.status)
        )
    ).all()
    candidate_status_counts = {str(value): int(count) for value, count in status_counts_rows}
    total_candidates = sum(candidate_status_counts.values())
    total_accounts = await _scalar_count(session, select(func.count(TwitterAccount.id)))
    total_evidence = await _scalar_count(session, select(func.count(TwitterDiscoveryEvidence.id)))
    total_posts = await _scalar_count(session, select(func.count(TwitterPost.id)))

    last_run = (
        await session.execute(
            select(TwitterDiscoveryRun)
            .order_by(TwitterDiscoveryRun.started_at.desc())
            .limit(1)
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
    latest_account = (
        await session.execute(
            select(TwitterAccount).order_by(TwitterAccount.first_seen_at.desc()).limit(1)
        )
    ).scalar_one_or_none()

    x_api_configured = bool(settings.x_api_bearer_token.strip())
    x_api_enabled = bool(config.x_api_enrichment_enabled and x_api_configured)
    public_enabled = bool(
        config.dexscreener_enabled
        or config.coinmarketcap_enabled
        or config.seed_discovery_enabled
        or config.public_web_enabled
    )
    mode = "hybrid" if x_api_enabled and public_enabled else "x_api" if x_api_enabled else "public_no_x_api"

    discovery_status = "disabled" if not config.discovery_enabled else "idle"
    if config.discovery_enabled and last_run and last_run.status == "running":
        discovery_status = "running"
    elif config.discovery_enabled and last_failed and (
        not last_success or last_failed.started_at > last_success.started_at
    ):
        discovery_status = "failed"

    now = utcnow()
    metrics = {
        "1h": await _window_metrics(session, now - timedelta(hours=1)),
        "24h": await _window_metrics(session, now - timedelta(hours=24)),
        "7d": await _window_metrics(session, now - timedelta(days=7)),
    }

    return {
        "status": discovery_status,
        "x_api_configured": x_api_configured,
        "x_api_enrichment_enabled": config.x_api_enrichment_enabled,
        "mode": mode,
        "total_candidates": total_candidates,
        "candidate_status_counts": candidate_status_counts,
        "total_accounts": total_accounts,
        "total_evidence": total_evidence,
        "total_posts": total_posts,
        "last_run": last_run.started_at.isoformat() if last_run else None,
        "last_successful_run": last_success.started_at.isoformat() if last_success else None,
        "last_failed_run": last_failed.started_at.isoformat() if last_failed else None,
        "last_new_candidate": latest_candidate.first_seen_at.isoformat() if latest_candidate else None,
        "last_new_evidence": latest_evidence.observed_at.isoformat() if latest_evidence else None,
        "last_promoted_account": latest_account.first_seen_at.isoformat() if latest_account else None,
        "last_run_duration_seconds": (
            (last_run.finished_at - last_run.started_at).total_seconds()
            if last_run and last_run.finished_at
            else None
        ),
        "worker_id": last_run.worker_id if last_run else None,
        "metrics": metrics,
    }


@router.get("/candidates")
async def list_candidates(
    session: AsyncSession = Depends(get_db),
    status_filter: str | None = Query(default=None, alias="status"),
    source: str | None = Query(default=None, max_length=48),
    search: str | None = Query(default=None, max_length=128),
    min_score: float | None = Query(default=None, ge=0.0, le=100.0),
    promoted: bool | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    sort_by: Literal["first_seen", "last_seen", "score", "confidence", "priority"] = "first_seen",
    order: Literal["asc", "desc"] = "desc",
) -> dict[str, Any]:
    stmt = select(TwitterDiscoveryCandidate, TwitterDiscoveryScore).outerjoin(
        TwitterDiscoveryScore,
        TwitterDiscoveryScore.candidate_id == TwitterDiscoveryCandidate.id,
    )
    if status_filter:
        stmt = stmt.where(TwitterDiscoveryCandidate.status == status_filter)
    if source:
        stmt = stmt.where(
            exists(
                select(TwitterDiscoveryEvidence.id).where(
                    TwitterDiscoveryEvidence.candidate_id == TwitterDiscoveryCandidate.id,
                    _evidence_source_condition(source),
                )
            )
        )
    if search and search.strip():
        pattern = f"%{search.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(TwitterDiscoveryCandidate.username).like(pattern),
                func.lower(TwitterDiscoveryCandidate.display_name).like(pattern),
                func.lower(TwitterDiscoveryCandidate.candidate_key).like(pattern),
            )
        )
    if promoted is True:
        stmt = stmt.where(TwitterDiscoveryCandidate.account_id.is_not(None))
    elif promoted is False:
        stmt = stmt.where(TwitterDiscoveryCandidate.account_id.is_(None))
    if min_score is not None:
        stmt = stmt.where(TwitterDiscoveryScore.discovery_score >= min_score)

    total = await _scalar_count(session, select(func.count()).select_from(stmt.subquery()))
    sort_columns = {
        "first_seen": TwitterDiscoveryCandidate.first_seen_at,
        "last_seen": TwitterDiscoveryCandidate.last_seen_at,
        "score": TwitterDiscoveryScore.discovery_score,
        "confidence": TwitterDiscoveryScore.confidence,
        "priority": TwitterDiscoveryCandidate.priority,
    }
    sort_col = sort_columns[sort_by]
    stmt = stmt.order_by(sort_col.asc() if order == "asc" else sort_col.desc())
    rows = (await session.execute(stmt.limit(limit).offset(offset))).all()

    candidate_ids = [candidate.id for candidate, _score in rows]
    source_map: dict[int, set[str]] = {candidate_id: set() for candidate_id in candidate_ids}
    evidence_counts: dict[int, int] = {candidate_id: 0 for candidate_id in candidate_ids}
    if candidate_ids:
        grouped = (
            await session.execute(
                select(
                    TwitterDiscoveryEvidence.candidate_id,
                    TwitterDiscoveryEvidence.source_type,
                    func.count(TwitterDiscoveryEvidence.id),
                )
                .where(TwitterDiscoveryEvidence.candidate_id.in_(candidate_ids))
                .group_by(
                    TwitterDiscoveryEvidence.candidate_id,
                    TwitterDiscoveryEvidence.source_type,
                )
            )
        ).all()
        for candidate_id, source_type, count in grouped:
            source_map[int(candidate_id)].add(str(source_type))
            evidence_counts[int(candidate_id)] += int(count)

    items = []
    for candidate, score in rows:
        profile = profile_from_meta(candidate.meta)
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
                "first_seen_at": candidate.first_seen_at.isoformat() if candidate.first_seen_at else None,
                "last_seen_at": candidate.last_seen_at.isoformat() if candidate.last_seen_at else None,
                "discovery_score": score.discovery_score if score else 0.0,
                "confidence": score.confidence if score else 0.0,
                "evidence_count": evidence_counts.get(candidate.id, 0),
                "sources": sorted(source_map.get(candidate.id, set())),
                "promotion_ready": bool(
                    candidate.twitter_id
                    and profile is not None
                    and profile.twitter_id == candidate.twitter_id
                    and candidate.account_id is None
                    and candidate.status not in {"processing", "duplicate"}
                ),
            }
        )
    return {"items": items, "meta": {"total": total, "limit": limit, "offset": offset}}


@router.get("/candidates/{candidate_id}")
async def get_candidate_detail(
    candidate_id: int,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    candidate = await session.get(TwitterDiscoveryCandidate, candidate_id)
    if candidate is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Candidate not found")
    score = await session.get(TwitterDiscoveryScore, candidate_id)
    evidence_rows = (
        await session.execute(
            select(TwitterDiscoveryEvidence)
            .where(TwitterDiscoveryEvidence.candidate_id == candidate_id)
            .order_by(TwitterDiscoveryEvidence.observed_at.desc())
        )
    ).scalars().all()
    canonical = await session.get(TwitterAccount, candidate.account_id) if candidate.account_id else None
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
            "lease_expires_at": candidate.lease_expires_at.isoformat() if candidate.lease_expires_at else None,
            "last_attempt_at": candidate.last_attempt_at.isoformat() if candidate.last_attempt_at else None,
            "next_attempt_at": candidate.next_attempt_at.isoformat() if candidate.next_attempt_at else None,
            "last_error": candidate.last_error,
            "first_seen_at": candidate.first_seen_at.isoformat() if candidate.first_seen_at else None,
            "last_seen_at": candidate.last_seen_at.isoformat() if candidate.last_seen_at else None,
            "meta": candidate.meta,
        },
        "score": (
            {
                "discovery_score": score.discovery_score,
                "confidence": score.confidence,
                "relevance_score": score.relevance_score,
                "source_score": score.source_score,
                "graph_score": score.graph_score,
                "engagement_score": score.engagement_score,
                "early_signal_score": score.early_signal_score,
                "recency_score": score.recency_score,
                "evidence_count": score.evidence_count,
                "score_version": score.score_version,
                "scored_at": score.scored_at.isoformat() if score.scored_at else None,
                "components": score.components,
            }
            if score
            else None
        ),
        "evidence": [
            {
                "id": item.id,
                "source_type": item.source_type,
                "source_ref": item.source_ref,
                "discovery_reason": item.discovery_reason,
                "query": item.query,
                "source_url": item.source_url,
                "observed_at": item.observed_at.isoformat() if item.observed_at else None,
                "raw": item.raw,
            }
            for item in evidence_rows
        ],
        "canonical_account": (
            {
                "id": canonical.id,
                "twitter_id": canonical.twitter_id,
                "username": canonical.username,
                "display_name": canonical.display_name,
                "status": canonical.status,
            }
            if canonical
            else None
        ),
    }


@router.get("/accounts")
async def list_accounts(
    session: AsyncSession = Depends(get_db),
    status_filter: str | None = Query(default=None, alias="status"),
    account_type: str | None = Query(default=None),
    search: str | None = Query(default=None, max_length=128),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    filters: list[Any] = []
    if status_filter:
        filters.append(TwitterAccount.status == status_filter)
    if account_type:
        filters.append(TwitterAccount.account_type == account_type)
    if search and search.strip():
        pattern = f"%{search.strip().lower()}%"
        filters.append(
            or_(
                func.lower(TwitterAccount.username).like(pattern),
                func.lower(TwitterAccount.display_name).like(pattern),
                func.lower(TwitterAccount.twitter_id).like(pattern),
            )
        )
    count_stmt = select(func.count(TwitterAccount.id))
    stmt = select(TwitterAccount, TwitterAccountScore).outerjoin(
        TwitterAccountScore, TwitterAccountScore.account_id == TwitterAccount.id
    )
    if filters:
        count_stmt = count_stmt.where(*filters)
        stmt = stmt.where(*filters)
    total = await _scalar_count(session, count_stmt)
    rows = (
        await session.execute(
            stmt.order_by(TwitterAccount.last_seen_at.desc()).limit(limit).offset(offset)
        )
    ).all()
    items = [
        {
            "id": account.id,
            "twitter_id": account.twitter_id,
            "username": account.username,
            "display_name": account.display_name,
            "account_type": account.account_type,
            "status": account.status,
            "followers_count": account.followers_count,
            "following_count": account.following_count,
            "tweet_count": account.tweet_count,
            "verified": account.verified,
            "source": account.source,
            "first_seen_at": account.first_seen_at.isoformat() if account.first_seen_at else None,
            "last_seen_at": account.last_seen_at.isoformat() if account.last_seen_at else None,
            "alpha_score": score.alpha_score if score else 0.0,
            "trust_score": score.trust_score if score else 0.0,
            "influence_score": score.influence_score if score else 0.0,
        }
        for account, score in rows
    ]
    return {"items": items, "meta": {"total": total, "limit": limit, "offset": offset}}


@router.get("/accounts/{account_id}")
async def get_account_detail(
    account_id: int,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    account = await session.get(TwitterAccount, account_id)
    if account is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")
    score = await session.get(TwitterAccountScore, account_id)
    snapshots_count = await _scalar_count(
        session,
        select(func.count(TwitterAccountSnapshot.id)).where(
            TwitterAccountSnapshot.account_id == account_id
        ),
    )
    posts_count = await _scalar_count(
        session,
        select(func.count(TwitterPost.id)).where(TwitterPost.account_id == account_id),
    )
    token_stats_count = await _scalar_count(
        session,
        select(func.count(TwitterAccountTokenStat.id)).where(
            TwitterAccountTokenStat.account_id == account_id
        ),
    )
    snapshots = (
        await session.execute(
            select(TwitterAccountSnapshot)
            .where(TwitterAccountSnapshot.account_id == account_id)
            .order_by(TwitterAccountSnapshot.captured_at.desc())
            .limit(20)
        )
    ).scalars().all()
    posts = (
        await session.execute(
            select(TwitterPost)
            .where(TwitterPost.account_id == account_id)
            .order_by(TwitterPost.published_at.desc())
            .limit(20)
        )
    ).scalars().all()
    token_stats = (
        await session.execute(
            select(TwitterAccountTokenStat)
            .where(TwitterAccountTokenStat.account_id == account_id)
            .order_by(TwitterAccountTokenStat.token_alpha_score.desc())
            .limit(20)
        )
    ).scalars().all()
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
            "last_profile_sync_at": account.last_profile_sync_at.isoformat() if account.last_profile_sync_at else None,
            "raw": account.raw,
        },
        "score": (
            {
                "influence_score": score.influence_score,
                "trust_score": score.trust_score,
                "alpha_score": score.alpha_score,
                "shill_score": score.shill_score,
                "bot_score": score.bot_score,
                "crypto_relevance_score": score.crypto_relevance_score,
                "solana_relevance_score": score.solana_relevance_score,
                "score_confidence": score.score_confidence,
                "score_source": score.score_source,
                "model_version": score.model_version,
                "updated_at": score.updated_at.isoformat() if score.updated_at else None,
            }
            if score
            else None
        ),
        "snapshots_count": snapshots_count,
        "posts_count": posts_count,
        "token_stats_count": token_stats_count,
        "snapshots": [
            {
                "followers_count": row.followers_count,
                "following_count": row.following_count,
                "tweet_count": row.tweet_count,
                "verified": row.verified,
                "captured_at": row.captured_at.isoformat() if row.captured_at else None,
                "source": row.source,
            }
            for row in snapshots
        ],
        "posts": [
            {
                "twitter_post_id": row.twitter_post_id,
                "text": row.text,
                "published_at": row.published_at.isoformat() if row.published_at else None,
                "likes": row.likes,
                "reposts": row.reposts,
                "replies": row.replies,
                "views": row.views,
                "source_url": row.source_url,
            }
            for row in posts
        ],
        "token_stats": [
            {
                "mint_address": row.mint_address,
                "mentions_count": row.mentions_count,
                "successful_calls": row.successful_calls,
                "failed_calls": row.failed_calls,
                "token_alpha_score": row.token_alpha_score,
                "updated_at": row.updated_at.isoformat() if row.updated_at else None,
            }
            for row in token_stats
        ],
    }


@router.get("/evidence")
async def list_evidence(
    session: AsyncSession = Depends(get_db),
    candidate_id: int | None = Query(default=None, ge=1),
    source_type: str | None = Query(default=None, max_length=48),
    search: str | None = Query(default=None, max_length=128),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    stmt = select(TwitterDiscoveryEvidence, TwitterDiscoveryCandidate).join(
        TwitterDiscoveryCandidate,
        TwitterDiscoveryCandidate.id == TwitterDiscoveryEvidence.candidate_id,
    )
    if candidate_id is not None:
        stmt = stmt.where(TwitterDiscoveryEvidence.candidate_id == candidate_id)
    if source_type:
        stmt = stmt.where(_evidence_source_condition(source_type))
    if search and search.strip():
        pattern = f"%{search.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(TwitterDiscoveryCandidate.username).like(pattern),
                func.lower(TwitterDiscoveryCandidate.candidate_key).like(pattern),
                func.lower(TwitterDiscoveryEvidence.source_ref).like(pattern),
            )
        )
    total = await _scalar_count(session, select(func.count()).select_from(stmt.subquery()))
    rows = (
        await session.execute(
            stmt.order_by(TwitterDiscoveryEvidence.observed_at.desc()).limit(limit).offset(offset)
        )
    ).all()
    return {
        "items": [
            {
                "id": evidence.id,
                "candidate_id": evidence.candidate_id,
                "candidate_username": candidate.username,
                "candidate_key": candidate.candidate_key,
                "source_type": evidence.source_type,
                "source_ref": evidence.source_ref,
                "discovery_reason": evidence.discovery_reason,
                "query": evidence.query,
                "source_url": evidence.source_url,
                "observed_at": evidence.observed_at.isoformat() if evidence.observed_at else None,
                "raw": evidence.raw,
            }
            for evidence, candidate in rows
        ],
        "meta": {"total": total, "limit": limit, "offset": offset},
    }


@router.get("/runs")
async def list_discovery_runs(
    session: AsyncSession = Depends(get_db),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    await recover_stale_discovery_runs(session)
    total = await _scalar_count(session, select(func.count(TwitterDiscoveryRun.id)))
    runs = (
        await session.execute(
            select(TwitterDiscoveryRun)
            .order_by(TwitterDiscoveryRun.started_at.desc())
            .limit(limit)
            .offset(offset)
        )
    ).scalars().all()
    return {
        "items": [
            {
                "id": run.id,
                "started_at": run.started_at.isoformat() if run.started_at else None,
                "finished_at": run.finished_at.isoformat() if run.finished_at else None,
                "status": run.status,
                "worker_id": run.worker_id,
                "mode": run.mode,
                "trigger": run.trigger,
                "config_snapshot": run.config_snapshot,
                "candidates_created": run.candidates_created,
                "evidence_created": run.evidence_created,
                "rescored": run.rescored,
                "promoted": run.promoted,
                "skipped": run.skipped,
                "failed": run.failed,
                "error": run.error,
            }
            for run in runs
        ],
        "meta": {"total": total, "limit": limit, "offset": offset},
    }


@router.get("/config")
async def get_discovery_config(session: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    return _config_payload(await _get_or_create_config(session))


@router.patch("/config")
async def update_discovery_config(
    payload: TwitterDiscoveryConfigPatch,
    session: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_superuser),
) -> dict[str, Any]:
    config = await _get_or_create_config(session)
    for field, value in payload.model_dump(exclude_unset=True, exclude_none=True).items():
        setattr(config, field, value)
    config.updated_at = utcnow()
    config.updated_by = str(current_user.email or current_user.id)[:128]
    await session.commit()
    await session.refresh(config)
    return {"status": "success", "config": _config_payload(config)}


def _run_failed_count(public_summary: dict[str, Any], registry_summary: dict[str, Any]) -> int:
    failed = len(public_summary.get("errors") or [])
    failed += len(registry_summary.get("public_web_errors") or [])
    failed += len(registry_summary.get("x_search_errors") or [])
    frontier = registry_summary.get("frontier")
    if isinstance(frontier, dict):
        failed += int(frontier.get("failed") or 0)
    return failed


def _run_skipped_count(registry_summary: dict[str, Any]) -> int:
    frontier = registry_summary.get("frontier")
    if isinstance(frontier, dict):
        return int(frontier.get("rejected") or 0)
    return 1 if registry_summary.get("frontier_skipped") else 0


async def _execute_admin_discovery(
    *,
    payload: TwitterDiscoveryRunRequest,
    session: AsyncSession,
    settings: Settings,
    public_only: bool,
) -> dict[str, Any]:
    config = await _get_or_create_config(session)
    if not config.discovery_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Twitter discovery is disabled in settings",
        )
    if payload.public_urls and not config.public_web_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Public web discovery is disabled in settings",
        )

    x_enabled = bool(config.x_api_enrichment_enabled and settings.x_api_bearer_token.strip())
    public_market_enabled = bool(config.dexscreener_enabled or config.coinmarketcap_enabled)
    registry_enabled = bool(config.seed_discovery_enabled or payload.public_urls or x_enabled)
    if public_only and not public_market_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="All public market discovery sources are disabled in settings",
        )
    if not public_only and not public_market_enabled and not registry_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="All discovery sources are disabled in settings",
        )
    mode = "public_no_x_api"
    if x_enabled and public_market_enabled and not public_only:
        mode = "hybrid"
    elif x_enabled and not public_only:
        mode = "x_api"

    worker_id = f"admin-api:{uuid4().hex[:16]}"
    try:
        context = await start_discovery_run(
            session,
            mode=mode,
            trigger=payload.trigger,
            worker_id=worker_id,
            config_snapshot={
                **_safe_config_snapshot(config),
                "public_only": public_only,
                "public_url_count": len(payload.public_urls),
                "x_api_configured": bool(settings.x_api_bearer_token.strip()),
            },
        )
    except DiscoveryRunBusy as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    public_summary: dict[str, Any] = {}
    registry_summary: dict[str, Any] = {}
    try:
        if public_market_enabled:
            public_summary = await run_public_discovery(
                Namespace(
                    dexscreener_latest=bool(config.dexscreener_enabled),
                    dexscreener_boosts=bool(config.dexscreener_enabled),
                    db_solana_tokens=0,
                    cmc_limit=config.cmc_limit if config.coinmarketcap_enabled else 0,
                    rescore_limit=config.rescore_limit,
                    dry_run=False,
                )
            )
            await touch_discovery_run(session, context)

        if not public_only and registry_enabled:
            registry_summary = await run_registry_discovery(
                Namespace(
                    seed_file="data/twitter-discovery/crypto_media_seeds.json",
                    queries_file="data/twitter-discovery/queries.json",
                    public_url=[str(value) for value in payload.public_urls]
                    if config.public_web_enabled
                    else [],
                    skip_seeds=not config.seed_discovery_enabled,
                    skip_x_search=not x_enabled,
                    skip_frontier=not x_enabled,
                    query_limit=min(max(1, config.batch_size), 100),
                    process_limit=config.process_limit,
                    batch_size=config.batch_size,
                    max_depth=config.max_depth,
                    min_relevance=config.min_relevance,
                    network_mode="following" if x_enabled else "none",
                    network_limit=config.network_limit,
                    lease_seconds=300,
                    worker_id=context.worker_id,
                    dry_run=False,
                )
            )

        rescored = int((public_summary.get("rescore") or {}).get("rescored") or 0)
        failed = _run_failed_count(public_summary, registry_summary)
        skipped = _run_skipped_count(registry_summary)
        summary = {"public": public_summary, "registry": registry_summary}
        await finish_discovery_run(
            session,
            context,
            status="completed",
            summary=summary,
            rescored=rescored,
            failed=failed,
            skipped=skipped,
        )
        return {"status": "success", "run_id": context.run_id, "summary": summary}
    except Exception as exc:
        await fail_discovery_run(session, context, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Discovery run failed; inspect the admin run history for details",
        ) from exc


@router.post("/actions/run")
async def action_run_discovery(
    payload: TwitterDiscoveryRunRequest,
    session: AsyncSession = Depends(get_db),
    settings: Settings = Depends(_get_settings),
) -> dict[str, Any]:
    return await _execute_admin_discovery(
        payload=payload,
        session=session,
        settings=settings,
        public_only=False,
    )


@router.post("/actions/run-public")
async def action_run_public_discovery(
    payload: TwitterDiscoveryRunRequest,
    session: AsyncSession = Depends(get_db),
    settings: Settings = Depends(_get_settings),
) -> dict[str, Any]:
    return await _execute_admin_discovery(
        payload=payload,
        session=session,
        settings=settings,
        public_only=True,
    )


@router.post("/actions/rescore")
async def action_rescore(session: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    config = await _get_or_create_config(session)
    if not config.discovery_enabled:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Twitter discovery is disabled in settings")
    worker_id = f"admin-rescore:{uuid4().hex[:16]}"
    try:
        context = await start_discovery_run(
            session,
            mode="rescore",
            trigger="admin_rescore",
            worker_id=worker_id,
            config_snapshot={"rescore_limit": config.rescore_limit},
        )
    except DiscoveryRunBusy as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    try:
        stats = await rescore_discovery_candidates(session, limit=config.rescore_limit)
        await session.commit()
        await finish_discovery_run(
            session,
            context,
            status="completed",
            summary={"rescore": stats},
            rescored=int(stats.get("rescored") or 0),
        )
        return {"status": "success", "run_id": context.run_id, "stats": stats}
    except Exception as exc:
        await session.rollback()
        await fail_discovery_run(session, context, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Rescore failed; inspect the admin run history for details",
        ) from exc


@router.post("/actions/candidates/{candidate_id}/promote")
async def action_promote_candidate(
    candidate_id: int,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    candidate = await session.get(TwitterDiscoveryCandidate, candidate_id)
    if candidate is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Candidate not found")
    if candidate.account_id is not None or candidate.status == "accepted":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Candidate is already promoted")
    if not candidate.twitter_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Stable X user ID unavailable. Candidate can be discovered and scored, "
                "but canonical promotion requires reliable twitter_id resolution."
            ),
        )
    profile = profile_from_meta(candidate.meta)
    if profile is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Resolved profile metadata missing for candidate",
        )
    if profile.twitter_id != candidate.twitter_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Resolved profile twitter_id does not match candidate twitter_id",
        )

    previous_status = candidate.status
    claim_token = f"admin-promote:{uuid4().hex}"
    claim = await session.execute(
        update(TwitterDiscoveryCandidate)
        .where(
            TwitterDiscoveryCandidate.id == candidate_id,
            TwitterDiscoveryCandidate.account_id.is_(None),
            ~TwitterDiscoveryCandidate.status.in_(("accepted", "processing", "duplicate")),
        )
        .values(
            status="processing",
            lease_owner=claim_token,
            lease_expires_at=utcnow() + timedelta(minutes=5),
        )
    )
    if not claim.rowcount:
        await session.rollback()
        current = await session.get(TwitterDiscoveryCandidate, candidate_id)
        if current and current.account_id is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Candidate is already promoted")
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Candidate is already being processed")
    await session.commit()
    candidate = await session.get(TwitterDiscoveryCandidate, candidate_id)
    if candidate is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Candidate not found")

    try:
        config = await _get_or_create_config(session)
        accepted, account_id, relevance = await promote_candidate(
            session,
            candidate,
            profile,
            min_relevance=config.min_relevance,
        )
        await session.execute(
            update(TwitterDiscoveryCandidate)
            .where(
                TwitterDiscoveryCandidate.id == candidate_id,
                TwitterDiscoveryCandidate.lease_owner == claim_token,
            )
            .values(lease_owner=None, lease_expires_at=None)
        )
        await session.commit()
        return {
            "status": "success",
            "accepted": accepted,
            "account_id": account_id,
            "relevance_score": relevance,
        }
    except Exception:
        await session.rollback()
        await session.execute(
            update(TwitterDiscoveryCandidate)
            .where(
                TwitterDiscoveryCandidate.id == candidate_id,
                TwitterDiscoveryCandidate.account_id.is_(None),
                TwitterDiscoveryCandidate.lease_owner == claim_token,
            )
            .values(
                status=previous_status,
                lease_owner=None,
                lease_expires_at=None,
            )
        )
        await session.commit()
        raise
