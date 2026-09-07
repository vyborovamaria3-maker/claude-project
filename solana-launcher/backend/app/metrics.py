from __future__ import annotations

import os

from fastapi import Response
from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, generate_latest, multiprocess
from prometheus_fastapi_instrumentator import Instrumentator


def instrument_app(app) -> None:
    instrumentator = Instrumentator().instrument(app)
    if not os.getenv("PROMETHEUS_MULTIPROC_DIR"):
        instrumentator.expose(
            app,
            include_in_schema=False,
            should_gzip=True,
        )
        return

    # Celery workers run in separate processes/containers. In production they
    # share PROMETHEUS_MULTIPROC_DIR with FastAPI, so the API scrape endpoint must
    # aggregate the files rather than exposing only its own in-memory registry.
    @app.get("/metrics", include_in_schema=False)
    async def multiprocess_metrics() -> Response:
        registry = CollectorRegistry()
        multiprocess.MultiProcessCollector(registry)
        return Response(
            content=generate_latest(registry),
            media_type=CONTENT_TYPE_LATEST,
        )
