from __future__ import annotations

import asyncio

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.telegram_parser import normalize_telegram_target
from app.services.telegram_runtime_admin import AdminManagedTelegramMonitorManager


async def main() -> None:
    settings = get_settings()
    channels = [
        normalize_telegram_target(item)
        for item in settings.telegram_monitor_channels.split(",")
        if normalize_telegram_target(item)
    ]
    if not channels:
        raise SystemExit("TG_MONITOR_CHANNELS must contain at least one channel or group")

    # This CLI exists specifically to run the monitor, so autostart is implicit.
    # Provider credentials may still come from env fallback or Admin -> Integrations.
    settings.telegram_autostart = True
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    manager = AdminManagedTelegramMonitorManager(settings, sessionmaker)
    try:
        manager.start_background()
        while True:
            await asyncio.sleep(3600)
    finally:
        await manager.close()
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
