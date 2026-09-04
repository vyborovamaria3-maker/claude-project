from __future__ import annotations

import asyncio
import contextlib
from time import monotonic
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.services.social_intelligence import evaluate_calls
from app.services.telegram_discovery_registry import (
    due_registry_channels,
    record_discovery_results,
    registry_summary,
)
from app.services.telegram_intelligence import TelegramIntelligenceService
from app.services.telegram_outcomes import evaluate_outcome_windows
from app.services.telegram_parser import normalize_telegram_target
from app.services.telegram_public_discovery import TelegramPublicWebDiscoveryCollector


class TelegramMonitorManager:
    """Own Telegram collectors, background discovery and safe MTProto/public-web fallback."""

    def __init__(self, settings: Settings, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self.settings = settings
        self.sessionmaker = sessionmaker
        self.service: TelegramIntelligenceService | None = None
        self.public_web = TelegramPublicWebDiscoveryCollector(settings, sessionmaker)
        self._lock = asyncio.Lock()
        self._runtime_session_string: str | None = None
        self._background_task: asyncio.Task | None = None
        self._background_running = False
        self._public_bootstrapped = False
        self._last_background_error: str | None = None
        self._last_refresh_due = 0
        self._next_evaluation_at = 0.0
        self._last_evaluation: dict[str, Any] | None = None
        self._last_outcome_windows: dict[str, Any] | None = None
        self._last_evaluation_error: str | None = None
        self._registry_summary: dict[str, Any] = {
            "total": 0,
            "validated": 0,
            "rejected": 0,
            "unavailable": 0,
            "candidate": 0,
            "due": 0,
        }

    @property
    def mtproto_configured(self) -> bool:
        return bool(self.settings.telegram_api_id and self.settings.telegram_api_hash)

    @property
    def session_configured(self) -> bool:
        return bool(self._runtime_session_string or self.settings.telegram_session_string)

    @property
    def manual_public_channels(self) -> list[str]:
        raw = self.settings.telegram_public_web_channels.strip() or self.settings.telegram_monitor_channels.strip()
        result: list[str] = []
        for item in raw.split(","):
            normalized = normalize_telegram_target(item)
            if normalized and normalized not in result:
                result.append(normalized)
        return result

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
        force_accept_explicit: bool = True,
    ) -> dict[str, Any]:
        result = await self.public_web.scan_channels(
            channels,
            history_limit=history_limit,
            force_accept_explicit=force_accept_explicit,
        )
        rows = result.get("results") or []
        if isinstance(rows, list):
            await record_discovery_results(
                self.sessionmaker,
                [row for row in rows if isinstance(row, dict)],
                manual_channels=set(self.manual_public_channels),
                database_channels=set(self.public_web.database_seed_channels),
                strong_seconds=self.settings.telegram_public_web_refresh_strong_seconds,
                normal_seconds=self.settings.telegram_public_web_refresh_normal_seconds,
                rejected_seconds=self.settings.telegram_public_web_refresh_rejected_seconds,
                unavailable_seconds=self.settings.telegram_public_web_refresh_unavailable_seconds,
            )
            self._registry_summary = await registry_summary(self.sessionmaker)
        return result

    async def _mtproto_running(self) -> bool:
        if self.service is None:
            return False
        status = self.service.monitor_status()
        return bool(status.get("running"))

    async def _ensure_mtproto_monitor(self) -> bool:
        channels = [
            normalize_telegram_target(item)
            for item in self.settings.telegram_monitor_channels.split(",")
            if normalize_telegram_target(item)
        ]
        if not (
            self.settings.telegram_autostart
            and channels
            and self.mtproto_configured
            and self.session_configured
        ):
            return False
        if await self._mtproto_running():
            return True
        service = await self.get_service()
        graph = await service.scan_graph(
            channels,
            max_depth=self.settings.telegram_graph_depth,
            post_limit=self.settings.telegram_history_limit,
            entity_limit=self.settings.telegram_entity_limit,
        )
        discovered = [
            str(row.get("username") or "").strip()
            for row in graph.get("results", [])
            if not row.get("error") and row.get("username")
        ]
        monitored = list(dict.fromkeys([*channels, *discovered]))
        await service.start_monitor(monitored)
        return True

    async def _refresh_public_web_once(self) -> None:
        if not self.settings.telegram_public_web_enabled:
            return
        if not self.settings.telegram_public_web_refresh_enabled:
            if not self._public_bootstrapped and self.public_web.configured_channels:
                await self.scan_public_web(history_limit=self.settings.telegram_public_web_history_limit)
                self._public_bootstrapped = True
            return

        if not self._public_bootstrapped:
            if self.public_web.configured_channels:
                await self.scan_public_web(history_limit=self.settings.telegram_public_web_history_limit)
                self._public_bootstrapped = True
                return
            self._registry_summary = await registry_summary(self.sessionmaker)
            self._public_bootstrapped = True

        due = await due_registry_channels(
            self.sessionmaker,
            limit=self.settings.telegram_public_web_refresh_batch_size,
        )
        self._last_refresh_due = len(due)
        if due:
            await self.scan_public_web(
                due,
                history_limit=self.settings.telegram_public_web_discovery_history_limit,
                force_accept_explicit=False,
            )
        else:
            self._registry_summary = await registry_summary(self.sessionmaker)

    async def _evaluate_calls_if_due(self) -> None:
        now = monotonic()
        if now < self._next_evaluation_at:
            return
        self._next_evaluation_at = now + self.settings.telegram_evaluate_interval_seconds
        try:
            async with self.sessionmaker() as session:
                self._last_evaluation = await evaluate_calls(session, limit=1000, window_hours=72)
            async with self.sessionmaker() as session:
                self._last_outcome_windows = await evaluate_outcome_windows(
                    session,
                    limit=1000,
                    commit=True,
                )
            self._last_evaluation_error = None
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._last_evaluation_error = str(exc)[:500]

    async def _background_loop(self) -> None:
        self._background_running = True
        try:
            while True:
                mtproto_running = False
                mtproto_error: str | None = None
                try:
                    mtproto_running = await self._ensure_mtproto_monitor()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    mtproto_error = str(exc)[:500]

                public_error: str | None = None
                if not mtproto_running:
                    try:
                        await self._refresh_public_web_once()
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        public_error = str(exc)[:500]

                await self._evaluate_calls_if_due()

                if public_error:
                    self._last_background_error = public_error
                elif mtproto_error and not self.settings.telegram_public_web_enabled:
                    self._last_background_error = mtproto_error
                elif mtproto_error:
                    self._last_background_error = f"MTProto: {mtproto_error}; Public Web fallback active"
                else:
                    self._last_background_error = None
                await asyncio.sleep(self.settings.telegram_public_web_refresh_tick_seconds)
        finally:
            self._background_running = False

    def start_background(self) -> None:
        if self._background_task is not None and not self._background_task.done():
            return
        self._background_task = asyncio.create_task(
            self._background_loop(),
            name="telegram-intelligence-background",
        )

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
        if self._background_task is not None:
            self._background_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._background_task
            self._background_task = None
        async with self._lock:
            if self.service is not None:
                await self.service.disconnect()
                self.service = None
        await self.public_web.close()

    def status(self) -> dict[str, Any]:
        if self.service is None:
            mtproto = {"running": False, "channels": [], "connected": False}
        else:
            mtproto = self.service.monitor_status()

        public_web = self.public_web.status()
        mtproto_active = bool(mtproto.get("running") or mtproto.get("connected"))
        public_web_active = bool(public_web.get("configured") and public_web.get("last_scan_at"))
        public_available = bool(public_web.get("configured") or self._registry_summary.get("total"))
        mtproto_ready = bool(self.mtproto_configured and self.session_configured)

        if mtproto_active:
            mode = "mtproto"
        elif public_web_active:
            mode = "public_web"
        elif public_available:
            mode = "public_web"
        elif mtproto_ready:
            mode = "mtproto"
        else:
            mode = "unavailable"

        channels = mtproto.get("channels") if mode == "mtproto" else public_web.get("channels")
        channels = channels if isinstance(channels, list) else []
        collector_running = bool(mtproto.get("running") or public_web.get("running"))
        return {
            "mode": mode,
            "configured": bool(self.mtproto_configured or public_available),
            "mtproto_configured": self.mtproto_configured,
            "session_configured": self.session_configured,
            # Collector execution and background scheduler are separate states. A healthy scheduler
            # must not make an unconfigured/stopped collector look actively connected.
            "running": collector_running,
            "background_running": self._background_running,
            "channels": channels,
            "connected": bool(mtproto.get("connected")),
            "public_web_enabled": bool(public_web.get("enabled")),
            "public_web_configured": bool(public_web.get("configured")),
            "public_web_channels": len(public_web.get("channels") or []),
            "public_web_discovery_enabled": bool(public_web.get("discovery_enabled")),
            "public_web_discovery_depth": int(public_web.get("discovery_depth") or 0),
            "public_web_discovery_entity_limit": int(public_web.get("discovery_entity_limit") or 0),
            "public_web_relevance_min_score": float(public_web.get("relevance_min_score") or 0.0),
            "public_web_seed_database_channels": int(public_web.get("seed_database_channels") or 0),
            "public_web_discovered_channels": int(public_web.get("last_discovered_channels") or 0),
            "public_web_accepted_discovered": int(public_web.get("last_accepted_discovered") or 0),
            "public_web_rejected_discovered": int(public_web.get("last_rejected_discovered") or 0),
            "registry": dict(self._registry_summary),
            "refresh_due": self._last_refresh_due,
            "refresh_tick_seconds": self.settings.telegram_public_web_refresh_tick_seconds,
            "last_scan_at": public_web.get("last_scan_at"),
            "last_scan_messages": int(public_web.get("last_scan_messages") or 0),
            "last_scan_matches": int(public_web.get("last_scan_matches") or 0),
            "evaluation": self._last_evaluation,
            "outcome_windows": self._last_outcome_windows,
            "evaluation_error": self._last_evaluation_error,
            "last_error": public_web.get("last_error") or self._last_background_error,
        }
