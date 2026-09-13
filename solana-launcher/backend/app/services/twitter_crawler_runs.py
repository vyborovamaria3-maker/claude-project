from __future__ import annotations

import logging
import os
import socket
from datetime import datetime, timezone
from typing import Any

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.models.twitter_crawler_run import TwitterCrawlerRun

logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _duration_ms(started_at: datetime, finished_at: datetime) -> int:
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)
    return max(0, int((finished_at - started_at).total_seconds() * 1000))


async def start_twitter_crawler_run(
    job_name: str,
    *,
    phase: str = "starting",
    meta: dict[str, Any] | None = None,
) -> int:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    try:
        async with sessionmaker() as session:
            now = _utcnow()
            row = TwitterCrawlerRun(
                job_name=job_name,
                status="running",
                phase=phase,
                worker=f"{socket.gethostname()}:{os.getpid()}",
                started_at=now,
                heartbeat_at=now,
                meta=meta,
            )
            session.add(row)
            await session.flush()
            run_id = row.id
            await session.commit()
            return run_id
    finally:
        await engine.dispose()


async def heartbeat_twitter_crawler_run(
    run_id: int,
    *,
    phase: str,
    summary: dict[str, Any] | None = None,
) -> None:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    try:
        async with sessionmaker() as session:
            row = await session.get(TwitterCrawlerRun, run_id)
            if row is None:
                return
            row.status = "running"
            row.phase = phase
            row.heartbeat_at = _utcnow()
            if summary is not None:
                row.summary = summary
            await session.commit()
    finally:
        await engine.dispose()


async def finish_twitter_crawler_run(
    run_id: int,
    *,
    status: str,
    phase: str,
    summary: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    try:
        async with sessionmaker() as session:
            row = await session.get(TwitterCrawlerRun, run_id)
            if row is None:
                return
            now = _utcnow()
            row.status = status
            row.phase = phase
            row.heartbeat_at = now
            row.finished_at = now
            row.duration_ms = _duration_ms(row.started_at, now)
            row.error = error
            if summary is not None:
                row.summary = summary
            await session.commit()
    finally:
        await engine.dispose()


async def try_start_twitter_crawler_run(
    job_name: str,
    *,
    phase: str = "starting",
    meta: dict[str, Any] | None = None,
) -> int | None:
    try:
        return await start_twitter_crawler_run(job_name, phase=phase, meta=meta)
    except Exception:
        logger.exception(
            "Twitter crawler monitoring could not start for job=%s; work will continue",
            job_name,
        )
        return None


async def try_heartbeat_twitter_crawler_run(
    run_id: int | None,
    *,
    phase: str,
    summary: dict[str, Any] | None = None,
) -> None:
    if run_id is None:
        return
    try:
        await heartbeat_twitter_crawler_run(run_id, phase=phase, summary=summary)
    except Exception:
        logger.exception(
            "Twitter crawler heartbeat failed for run_id=%s phase=%s; work will continue",
            run_id,
            phase,
        )


async def try_finish_twitter_crawler_run(
    run_id: int | None,
    *,
    status: str,
    phase: str,
    summary: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    if run_id is None:
        return
    try:
        await finish_twitter_crawler_run(
            run_id,
            status=status,
            phase=phase,
            summary=summary,
            error=error,
        )
    except Exception:
        logger.exception(
            "Twitter crawler monitoring could not finish run_id=%s status=%s",
            run_id,
            status,
        )
