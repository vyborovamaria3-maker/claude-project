from __future__ import annotations

import hashlib
import json
from typing import Any

from redis.exceptions import RedisError

from app.services.cache import get_redis_client

ANALYSIS_JOB_TTL_SECONDS = 1800
ANALYSIS_RESULT_TTL_SECONDS = 1800
ANALYSIS_JOB_SCHEMA_VERSION = "analysis-job-v1"


def _job_key(job_id: str) -> str:
    return f"analysis:job:{job_id}"


def _payload_key(job_id: str) -> str:
    return f"analysis:job:{job_id}:payload"


def _active_key(fingerprint: str) -> str:
    return f"analysis:request:{fingerprint}:active"


def _result_key(fingerprint: str) -> str:
    return f"analysis:request:{fingerprint}:result"


def analysis_request_fingerprint(
    *,
    snapshot: dict[str, Any],
    ai_result: dict[str, Any] | None,
    role: str,
    enrich: bool,
    persist: bool,
) -> str:
    raw = json.dumps(
        {
            "schema": ANALYSIS_JOB_SCHEMA_VERSION,
            "snapshot": snapshot,
            "ai_result": ai_result,
            "role": role,
            "enrich": enrich,
            "persist": persist,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def read_cached_analysis(fingerprint: str) -> dict[str, Any] | None:
    try:
        raw = await get_redis_client().get(_result_key(fingerprint))
    except RedisError as exc:
        raise RuntimeError("analysis result cache is unavailable") from exc
    if raw is None:
        return None
    value = json.loads(raw)
    return value if isinstance(value, dict) else None


async def reserve_analysis_job(fingerprint: str, job_id: str) -> str | None:
    """Reserve one active job per identical analysis request.

    Returns an already-active job id when another request won the reservation.
    """
    client = get_redis_client()
    try:
        reserved = await client.set(
            _active_key(fingerprint),
            job_id,
            nx=True,
            ex=ANALYSIS_JOB_TTL_SECONDS,
        )
        if reserved:
            return None
        current = await client.get(_active_key(fingerprint))
        return str(current) if current else None
    except RedisError as exc:
        raise RuntimeError("analysis job reservation is unavailable") from exc


async def release_analysis_reservation(fingerprint: str, job_id: str) -> None:
    client = get_redis_client()
    try:
        current = await client.get(_active_key(fingerprint))
        if current == job_id:
            await client.delete(_active_key(fingerprint))
    except RedisError:
        return


async def create_analysis_job(
    job_id: str,
    *,
    fingerprint: str,
    payload: dict[str, Any],
    preliminary_report: dict[str, Any],
) -> None:
    client = get_redis_client()
    state = {
        "job_id": job_id,
        "fingerprint": fingerprint,
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
    fingerprint: str,
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
        async with client.pipeline(transaction=True) as pipe:
            pipe.set(
                _result_key(fingerprint),
                json.dumps(report, default=str),
                ex=ANALYSIS_RESULT_TTL_SECONDS,
            )
            pipe.delete(_payload_key(job_id))
            await pipe.execute()
    except (RedisError, RuntimeError) as exc:
        raise RuntimeError("analysis job state is unavailable") from exc
    finally:
        await release_analysis_reservation(fingerprint, job_id)


async def fail_analysis_job(
    job_id: str,
    error: str,
    *,
    fingerprint: str | None = None,
) -> None:
    try:
        await update_analysis_job(
            job_id,
            status="failed",
            error=error[:1000],
        )
    except RuntimeError:
        pass
    if fingerprint:
        await release_analysis_reservation(fingerprint, job_id)
