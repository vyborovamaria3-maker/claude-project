from __future__ import annotations

import os
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.models.twitter_discovery_admin import TwitterDiscoveryRun, TwitterDiscoveryRunLock
from app.models.twitter_intelligence import (
    TwitterAccount,
    TwitterDiscoveryCandidate,
    TwitterDiscoveryEvidence,
)

LOCK_KEY = "twitter-discovery"
LOCK_LEASE_SECONDS = 12 * 60 * 60


def utcnow() -> datetime:
    return datetime.now(UTC)


class DiscoveryRunBusy(RuntimeError):
    pass


@dataclass(slots=True)
class DiscoveryRunContext:
    run_id: int
    owner_token: str
    worker_id: str
    started_at: datetime
    baseline_candidates: int
    baseline_evidence: int
    baseline_accounts: int


async def _count(session: AsyncSession, model: Any) -> int:
    value = (await session.execute(select(func.count(model.id)))).scalar_one()
    return int(value or 0)


async def recover_stale_discovery_runs(session: AsyncSession) -> int:
    now = utcnow()
    expired_rows = (
        await session.execute(
            select(TwitterDiscoveryRunLock).where(
                TwitterDiscoveryRunLock.lease_expires_at <= now
            )
        )
    ).scalars().all()
    recovered = 0
    for lock in expired_rows:
        if lock.run_id is not None:
            run = await session.get(TwitterDiscoveryRun, lock.run_id)
            if run is not None and run.status == "running":
                run.status = "failed"
                run.finished_at = now
                run.error = "stale discovery run recovered after lock lease expiry"
                recovered += 1
        await session.delete(lock)

    stale_before = now - timedelta(seconds=LOCK_LEASE_SECONDS)
    stale_runs = (
        await session.execute(
            select(TwitterDiscoveryRun).where(
                TwitterDiscoveryRun.status == "running",
                TwitterDiscoveryRun.started_at <= stale_before,
            )
        )
    ).scalars().all()
    for run in stale_runs:
        run.status = "failed"
        run.finished_at = now
        run.error = run.error or "stale discovery run recovered after timeout"
        recovered += 1

    if expired_rows or stale_runs:
        await session.commit()
    return recovered


async def start_discovery_run(
    session: AsyncSession,
    *,
    mode: str,
    trigger: str,
    worker_id: str,
    config_snapshot: dict[str, Any] | None = None,
) -> DiscoveryRunContext:
    await recover_stale_discovery_runs(session)
    now = utcnow()
    owner_token = uuid4().hex
    lease_expires_at = now + timedelta(seconds=LOCK_LEASE_SECONDS)

    claimed = False
    try:
        async with session.begin_nested():
            session.add(
                TwitterDiscoveryRunLock(
                    lock_key=LOCK_KEY,
                    owner_token=owner_token,
                    lease_expires_at=lease_expires_at,
                    updated_at=now,
                )
            )
            await session.flush()
        claimed = True
    except IntegrityError:
        claimed = False

    if not claimed:
        result = await session.execute(
            update(TwitterDiscoveryRunLock)
            .where(
                TwitterDiscoveryRunLock.lock_key == LOCK_KEY,
                TwitterDiscoveryRunLock.lease_expires_at <= now,
            )
            .values(
                owner_token=owner_token,
                run_id=None,
                lease_expires_at=lease_expires_at,
                updated_at=now,
            )
        )
        claimed = bool(result.rowcount)

    if not claimed:
        await session.rollback()
        raise DiscoveryRunBusy("A Twitter discovery run is already in progress")

    baseline_candidates = await _count(session, TwitterDiscoveryCandidate)
    baseline_evidence = await _count(session, TwitterDiscoveryEvidence)
    baseline_accounts = await _count(session, TwitterAccount)

    run = TwitterDiscoveryRun(
        started_at=now,
        status="running",
        worker_id=worker_id[:128],
        mode=mode[:32],
        trigger=trigger[:32],
        config_snapshot=config_snapshot,
    )
    session.add(run)
    await session.flush()
    await session.execute(
        update(TwitterDiscoveryRunLock)
        .where(
            TwitterDiscoveryRunLock.lock_key == LOCK_KEY,
            TwitterDiscoveryRunLock.owner_token == owner_token,
        )
        .values(run_id=run.id, updated_at=now)
    )
    await session.commit()

    return DiscoveryRunContext(
        run_id=run.id,
        owner_token=owner_token,
        worker_id=worker_id,
        started_at=now,
        baseline_candidates=baseline_candidates,
        baseline_evidence=baseline_evidence,
        baseline_accounts=baseline_accounts,
    )


async def touch_discovery_run(session: AsyncSession, context: DiscoveryRunContext) -> None:
    now = utcnow()
    result = await session.execute(
        update(TwitterDiscoveryRunLock)
        .where(
            TwitterDiscoveryRunLock.lock_key == LOCK_KEY,
            TwitterDiscoveryRunLock.owner_token == context.owner_token,
        )
        .values(
            lease_expires_at=now + timedelta(seconds=LOCK_LEASE_SECONDS),
            updated_at=now,
        )
    )
    if not result.rowcount:
        await session.rollback()
        raise DiscoveryRunBusy("Discovery run lock ownership was lost")
    await session.commit()


def _summary_rescored(summary: dict[str, Any] | None) -> int:
    if not isinstance(summary, dict):
        return 0
    value = summary.get("rescore")
    if isinstance(value, dict):
        return int(value.get("rescored") or 0)
    return int(summary.get("rescored") or 0)


def _summary_failed(summary: dict[str, Any] | None) -> int:
    if not isinstance(summary, dict):
        return 0
    failed = 0
    errors = summary.get("errors")
    if isinstance(errors, list):
        failed += len(errors)
    for key in ("public_web_errors", "x_search_errors"):
        value = summary.get(key)
        if isinstance(value, list):
            failed += len(value)
    frontier = summary.get("frontier")
    if isinstance(frontier, dict):
        failed += int(frontier.get("failed") or 0)
    return failed


def _summary_skipped(summary: dict[str, Any] | None) -> int:
    if not isinstance(summary, dict):
        return 0
    frontier = summary.get("frontier")
    if isinstance(frontier, dict):
        return int(frontier.get("rejected") or 0)
    return 1 if summary.get("frontier_skipped") else 0


async def finish_discovery_run(
    session: AsyncSession,
    context: DiscoveryRunContext,
    *,
    status: str,
    summary: dict[str, Any] | None = None,
    error: str | None = None,
    rescored: int | None = None,
    skipped: int | None = None,
    failed: int | None = None,
) -> TwitterDiscoveryRun | None:
    run = await session.get(TwitterDiscoveryRun, context.run_id)
    if run is None:
        return None

    current_candidates = await _count(session, TwitterDiscoveryCandidate)
    current_evidence = await _count(session, TwitterDiscoveryEvidence)
    current_accounts = await _count(session, TwitterAccount)

    run.status = status[:24]
    run.finished_at = utcnow()
    run.candidates_created = max(0, current_candidates - context.baseline_candidates)
    run.evidence_created = max(0, current_evidence - context.baseline_evidence)
    run.promoted = max(0, current_accounts - context.baseline_accounts)
    run.rescored = _summary_rescored(summary) if rescored is None else max(0, int(rescored))
    run.skipped = _summary_skipped(summary) if skipped is None else max(0, int(skipped))
    run.failed = _summary_failed(summary) if failed is None else max(0, int(failed))
    run.error = (error or "")[:4000] or None

    await session.execute(
        delete(TwitterDiscoveryRunLock).where(
            TwitterDiscoveryRunLock.lock_key == LOCK_KEY,
            TwitterDiscoveryRunLock.owner_token == context.owner_token,
        )
    )
    await session.commit()
    return run


async def fail_discovery_run(
    session: AsyncSession,
    context: DiscoveryRunContext,
    exc: BaseException,
) -> None:
    await finish_discovery_run(
        session,
        context,
        status="failed",
        error=str(exc),
        failed=1,
    )


async def run_tracked_cli(
    runner: Callable[[], Awaitable[dict[str, Any]]],
    *,
    mode: str,
    trigger: str,
    worker_id: str | None = None,
    config_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    resolved_worker = (worker_id or "").strip() or f"{socket.gethostname()}:{os.getpid()}"
    context: DiscoveryRunContext | None = None
    try:
        async with sessionmaker() as session:
            context = await start_discovery_run(
                session,
                mode=mode,
                trigger=trigger,
                worker_id=resolved_worker,
                config_snapshot=config_snapshot,
            )
        summary = await runner()
        async with sessionmaker() as session:
            await finish_discovery_run(
                session,
                context,
                status="completed",
                summary=summary,
            )
        return summary
    except Exception as exc:
        if context is not None:
            async with sessionmaker() as session:
                await fail_discovery_run(session, context, exc)
        raise
    finally:
        await engine.dispose()
