from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from typing import Any, TypeVar

from celery.signals import worker_process_shutdown

T = TypeVar("T")
_runner: asyncio.Runner | None = None


def run_async_task(coro: Coroutine[Any, Any, T]) -> T:
    # Prefork workers execute tasks serially. Keep pooled async clients on one loop.
    global _runner
    if _runner is None:
        _runner = asyncio.Runner()
    return _runner.run(coro)


@worker_process_shutdown.connect
def close_async_runtime(**_kwargs: Any) -> None:
    global _runner
    if _runner is not None:
        _runner.close()
        _runner = None
