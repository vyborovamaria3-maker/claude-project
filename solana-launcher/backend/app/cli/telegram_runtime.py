from __future__ import annotations

import asyncio
import contextlib

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.telegram_runtime import TelegramMonitorManager


async def main() -> None:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    manager = TelegramMonitorManager(settings, sessionmaker)
    stop = asyncio.Event()
    try:
        manager.start_background()
        print("[telegram-runtime] background collector started", flush=True)
        await stop.wait()
    except asyncio.CancelledError:
        raise
    finally:
        with contextlib.suppress(Exception):
            await manager.close()
        await engine.dispose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
