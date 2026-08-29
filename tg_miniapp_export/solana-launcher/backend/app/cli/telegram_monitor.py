from __future__ import annotations

import asyncio
import contextlib

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.social_intelligence import evaluate_calls
from app.services.telegram_intelligence import TelegramIntelligenceService
from app.services.telegram_parser import normalize_telegram_target


async def evaluate_loop(sessionmaker, interval_seconds: int) -> None:
    while True:
        await asyncio.sleep(max(60, interval_seconds))
        try:
            async with sessionmaker() as session:
                await evaluate_calls(session, limit=5000)
        except Exception as exc:
            print(f"[telegram-intelligence] call evaluation failed: {exc}", flush=True)


async def main() -> None:
    settings = get_settings()
    channels = [
        normalize_telegram_target(item)
        for item in settings.telegram_monitor_channels.split(",")
        if normalize_telegram_target(item)
    ]
    if not channels:
        raise SystemExit("TG_MONITOR_CHANNELS must contain at least one channel or group")

    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    service = TelegramIntelligenceService(settings, sessionmaker)
    evaluator: asyncio.Task | None = None
    try:
        await service.connect()
        graph = await service.scan_graph(
            channels,
            max_depth=settings.telegram_graph_depth,
            post_limit=settings.telegram_history_limit,
            entity_limit=settings.telegram_entity_limit,
        )
        discovered = [
            str(row.get("username") or "").strip()
            for row in graph.get("results", [])
            if not row.get("error") and row.get("username")
        ]
        monitored = list(dict.fromkeys([*channels, *discovered]))
        result = await service.start_monitor(monitored)
        print(
            f"[telegram-intelligence] monitoring {len(result['channels'])} channels/groups",
            flush=True,
        )
        evaluator = asyncio.create_task(
            evaluate_loop(sessionmaker, settings.telegram_evaluate_interval_seconds)
        )
        await service.client.run_until_disconnected()
    finally:
        if evaluator is not None:
            evaluator.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await evaluator
        await service.disconnect()
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
