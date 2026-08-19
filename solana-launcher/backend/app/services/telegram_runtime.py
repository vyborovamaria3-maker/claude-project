from __future__ import annotations

import asyncio
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.services.telegram_intelligence import TelegramIntelligenceService


class TelegramMonitorManager:
    """Own one Telethon client per FastAPI process and recover cleanly from failed connects."""

    def __init__(self, settings: Settings, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self.settings = settings
        self.sessionmaker = sessionmaker
        self.service: TelegramIntelligenceService | None = None
        self._lock = asyncio.Lock()
        self._runtime_session_string: str | None = None

    async def get_service(self) -> TelegramIntelligenceService:
        async with self._lock:
            if self.service is None:
                candidate = TelegramIntelligenceService(
                    self.settings,
                    self.sessionmaker,
                    session_string=self._runtime_session_string,
                )
                try:
                    await candidate.connect()
                except Exception:
                    try:
                        await candidate.disconnect()
                    finally:
                        self.service = None
                    raise
                self.service = candidate
            elif not self.service.client.is_connected():
                try:
                    await self.service.connect()
                except Exception:
                    stale = self.service
                    self.service = None
                    try:
                        await stale.disconnect()
                    finally:
                        pass
                    raise
            return self.service

    async def attach_session(self, session_string: str) -> dict[str, Any]:
        candidate = TelegramIntelligenceService(
            self.settings,
            self.sessionmaker,
            session_string=session_string,
        )
        try:
            await candidate.connect()
            me = await candidate.client.get_me()
        finally:
            await candidate.disconnect()

        async with self._lock:
            if self.service is not None:
                await self.service.disconnect()
            self.service = None
            self._runtime_session_string = session_string
        return {
            "authorized": True,
            "user_id": int(getattr(me, "id", 0) or 0),
            "username": getattr(me, "username", None),
        }

    async def close(self) -> None:
        async with self._lock:
            if self.service is not None:
                await self.service.disconnect()
                self.service = None

    def status(self) -> dict[str, Any]:
        if self.service is None:
            return {
                "configured": bool(
                    self.settings.telegram_api_id and self.settings.telegram_api_hash
                ),
                "session_configured": bool(
                    self._runtime_session_string or self.settings.telegram_session_string
                ),
                "running": False,
                "channels": [],
                "connected": False,
            }
        return {"configured": True, "session_configured": True, **self.service.monitor_status()}
