from __future__ import annotations

import asyncio
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.services.telegram_intelligence import TelegramIntelligenceService
from app.services.telegram_public_discovery import TelegramPublicWebDiscoveryCollector


class TelegramMonitorManager:
    """Own Telegram collectors for one FastAPI process and recover cleanly from failed connects."""

    def __init__(self, settings: Settings, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self.settings = settings
        self.sessionmaker = sessionmaker
        self.service: TelegramIntelligenceService | None = None
        self.public_web = TelegramPublicWebDiscoveryCollector(settings, sessionmaker)
        self._lock = asyncio.Lock()
        self._runtime_session_string: str | None = None

    @property
    def mtproto_configured(self) -> bool:
        return bool(self.settings.telegram_api_id and self.settings.telegram_api_hash)

    @property
    def session_configured(self) -> bool:
        return bool(self._runtime_session_string or self.settings.telegram_session_string)

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

    async def scan_public_web(
        self,
        channels: list[str] | None = None,
        *,
        history_limit: int | None = None,
    ) -> dict[str, Any]:
        return await self.public_web.scan_channels(channels, history_limit=history_limit)

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
        await self.public_web.close()

    def status(self) -> dict[str, Any]:
        if self.service is None:
            mtproto = {
                "running": False,
                "channels": [],
                "connected": False,
            }
        else:
            mtproto = self.service.monitor_status()

        public_web = self.public_web.status()
        mtproto_active = bool(mtproto.get("running") or mtproto.get("connected"))
        public_web_active = bool(public_web.get("configured") and public_web.get("last_scan_at"))

        if mtproto_active:
            mode = "mtproto"
        elif public_web_active:
            mode = "public_web"
        elif self.mtproto_configured:
            mode = "mtproto"
        elif public_web.get("configured"):
            mode = "public_web"
        else:
            mode = "unavailable"

        channels = mtproto.get("channels") if mode == "mtproto" else public_web.get("channels")
        channels = channels if isinstance(channels, list) else []
        return {
            "mode": mode,
            "configured": bool(self.mtproto_configured or public_web.get("configured")),
            "mtproto_configured": self.mtproto_configured,
            "session_configured": self.session_configured,
            "running": bool(mtproto.get("running") or public_web.get("running")),
            "channels": channels,
            "connected": bool(mtproto.get("connected")),
            "public_web_enabled": bool(public_web.get("enabled")),
            "public_web_configured": bool(public_web.get("configured")),
            "public_web_channels": len(public_web.get("channels") or []),
            "public_web_discovery_enabled": bool(public_web.get("discovery_enabled")),
            "public_web_discovery_depth": int(public_web.get("discovery_depth") or 0),
            "public_web_discovery_entity_limit": int(public_web.get("discovery_entity_limit") or 0),
            "public_web_relevance_min_score": float(public_web.get("relevance_min_score") or 0.0),
            "public_web_discovered_channels": int(public_web.get("last_discovered_channels") or 0),
            "public_web_accepted_discovered": int(public_web.get("last_accepted_discovered") or 0),
            "public_web_rejected_discovered": int(public_web.get("last_rejected_discovered") or 0),
            "last_scan_at": public_web.get("last_scan_at"),
            "last_scan_messages": int(public_web.get("last_scan_messages") or 0),
            "last_scan_matches": int(public_web.get("last_scan_matches") or 0),
            "last_error": public_web.get("last_error"),
        }
