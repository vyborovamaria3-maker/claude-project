from __future__ import annotations

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.advanced_intelligence_enrichment import enrich_advanced_report
from app.services.advanced_intelligence_persistence import (
    persist_advanced_intelligence_state,
)
from app.services.analysis_jobs import (
    fail_analysis_job,
    finish_analysis_job,
    read_analysis_payload,
    update_analysis_job,
)
from app.services.observability import ANALYSIS_STAGE_RUNTIME
from app.tasks.async_runtime import run_async_task
from app.tasks.celery_app import celery_app


async def _run(job_id: str) -> dict:
    payload = await read_analysis_payload(job_id)
    if payload is None:
        raise RuntimeError(f"analysis payload expired or missing for job {job_id}")

    fingerprint = str(payload.get("fingerprint") or "")
    if not fingerprint:
        raise RuntimeError(f"analysis fingerprint missing for job {job_id}")

    await update_analysis_job(job_id, status="running")
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    try:
        async with sessionmaker() as session:
            snapshot = payload["snapshot"]
            report = payload["preliminary_report"]
            ai_result = payload.get("ai_result")
            role = str(payload.get("role") or "analyst")

            if role == "analyst" and bool(payload.get("enrich", True)):
                with ANALYSIS_STAGE_RUNTIME.labels(stage="enrichment").time():
                    report = await enrich_advanced_report(
                        session,
                        settings,
                        snapshot=snapshot,
                        report=report,
                    )
            if bool(payload.get("persist", True)):
                with ANALYSIS_STAGE_RUNTIME.labels(stage="persistence").time():
                    await persist_advanced_intelligence_state(
                        session,
                        snapshot=snapshot,
                        report=report,
                        ai_result=ai_result,
                        role=role,
                    )
            await finish_analysis_job(
                job_id,
                fingerprint=fingerprint,
                report=report,
            )
            return {
                "job_id": job_id,
                "status": "completed",
                "snapshot_id": snapshot.get("snapshotId"),
                "mint": snapshot.get("mint"),
            }
    except Exception as exc:
        await fail_analysis_job(
            job_id,
            str(exc),
            fingerprint=fingerprint,
        )
        raise
    finally:
        await engine.dispose()


@celery_app.task(
    name="app.tasks.advanced_intelligence.enrich_report",
    acks_late=True,
)
def enrich_report(job_id: str) -> dict:
    return run_async_task(_run(job_id))
