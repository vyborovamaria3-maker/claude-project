from __future__ import annotations

import asyncio
import contextlib

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.cache import cache_json, delete_cache
from app.services.telegram_runtime import TelegramMonitorManager

RUNTIME_STATUS_CACHE_KEY = "telegram:runtime:status"
RUNTIME_STATUS_TTL_SECONDS = 30
RUNTIME_STATUS_REFRESH_SECONDS = 10


async def _publish_status(manager: TelegramMonitorManager) -> None:
    while True:
        try:
            payload = manager.status()
            payload["external_runtime"] = True
            await cache_json(
                RUNTIME_STATUS_CACHE_KEY,
                payload,
                RUNTIME_STATUS_TTL_SECONDS,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"[telegram-runtime] heartbeat failed: {exc}", flush=True)
        await asyncio.sleep(RUNTIME_STATUS_REFRESH_SECONDS)


async def main() -> None:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    manager = TelegramMonitorManager(settings, sessionmaker)
    stop = asyncio.Event()
    heartbeat: asyncio.Task | None = None
    try:
        manager.start_background()
        heartbeat = asyncio.create_task(
            _publish_status(manager),
            name="telegram-runtime-heartbeat",
        )
        print("[telegram-runtime] background collector started", flush=True)
        await stop.wait()
    except asyncio.CancelledError:
        raise
    finally:
        if heartbeat is not None:
            heartbeat.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat
        with contextlib.suppress(Exception):
            await delete_cache(RUNTIME_STATUS_CACHE_KEY)
        with contextlib.suppress(Exception):
            await manager.close()
        await engine.dispose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
