from __future__ import annotations

import json
from typing import Any

from redis.exceptions import RedisError

from app.services.cache import get_redis_client

ANALYSIS_JOB_TTL_SECONDS = 1800


def _job_key(job_id: str) -> str:
    return f"analysis:job:{job_id}"


def _payload_key(job_id: str) -> str:
    return f"analysis:job:{job_id}:payload"


async def create_analysis_job(
    job_id: str,
    *,
    payload: dict[str, Any],
    preliminary_report: dict[str, Any],
) -> None:
    client = get_redis_client()
    state = {
        "job_id": job_id,
        "status": "queued",
        "preliminary_report": preliminary_report,
    }
    try:
        async with client.pipeline(transaction=True) as pipe:
            pipe.set(
                _job_key(job_id),
                json.dumps(state, default=str),
                ex=ANALYSIS_JOB_TTL_SECONDS,
            )
            pipe.set(
                _payload_key(job_id),
                json.dumps(payload, default=str),
                ex=ANALYSIS_JOB_TTL_SECONDS,
            )
            await pipe.execute()
    except RedisError as exc:
        raise RuntimeError("analysis job state is unavailable") from exc


async def read_analysis_job(job_id: str) -> dict[str, Any] | None:
    try:
        raw = await get_redis_client().get(_job_key(job_id))
    except RedisError as exc:
        raise RuntimeError("analysis job state is unavailable") from exc
    if raw is None:
        return None
    value = json.loads(raw)
    return value if isinstance(value, dict) else None


async def read_analysis_payload(job_id: str) -> dict[str, Any] | None:
    try:
        raw = await get_redis_client().get(_payload_key(job_id))
    except RedisError as exc:
        raise RuntimeError("analysis job payload is unavailable") from exc
    if raw is None:
        return None
    value = json.loads(raw)
    return value if isinstance(value, dict) else None


async def update_analysis_job(job_id: str, **fields: Any) -> None:
    client = get_redis_client()
    try:
        raw = await client.get(_job_key(job_id))
        current = json.loads(raw) if raw else {"job_id": job_id}
        if not isinstance(current, dict):
            current = {"job_id": job_id}
        current.update(fields)
        await client.set(
            _job_key(job_id),
            json.dumps(current, default=str),
            ex=ANALYSIS_JOB_TTL_SECONDS,
        )
    except RedisError as exc:
        raise RuntimeError("analysis job state is unavailable") from exc


async def finish_analysis_job(
    job_id: str,
    *,
    report: dict[str, Any],
) -> None:
    client = get_redis_client()
    try:
        await update_analysis_job(
            job_id,
            status="completed",
            report=report,
            error=None,
        )
        await client.delete(_payload_key(job_id))
    except RedisError as exc:
        raise RuntimeError("analysis job state is unavailable") from exc


async def fail_analysis_job(job_id: str, error: str) -> None:
    try:
        await update_analysis_job(
            job_id,
            status="failed",
            error=error[:1000],
        )
    except RuntimeError:
        # The worker must still fail normally if Redis is unavailable; the Celery
        # result backend remains an independent operational signal.
        return
