from __future__ import annotations

from datetime import datetime, timezone
from time import monotonic
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.services.admin_integrations import fetch_admin_telegram_integrations
from app.services.telegram_runtime import TelegramMonitorManager


class AdminManagedTelegramMonitorManager(TelegramMonitorManager):
    """Telegram runtime with optional Admin -> Integrations credential overrides."""

    def __init__(self, settings: Settings, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        super().__init__(settings, sessionmaker)
        self._fallback_api_id = settings.telegram_api_id
        self._fallback_api_hash = settings.telegram_api_hash
        self._fallback_session_string = settings.telegram_session_string
        self._admin_refresh_due = 0.0
        self._admin_refresh_seconds = 30.0
        self._admin_last_refresh_at: str | None = None
        self._admin_last_error: str | None = None
        self._admin_override_active = False

    async def _refresh_admin_credentials(self, *, force: bool = False) -> None:
        now = monotonic()
        if not force and now < self._admin_refresh_due:
            return
        self._admin_refresh_due = now + self._admin_refresh_seconds

        snapshot, error = await fetch_admin_telegram_integrations()
        self._admin_last_refresh_at = datetime.now(timezone.utc).isoformat()
        self._admin_last_error = error
        if snapshot is None:
            # Missing control-plane config or a transient outage must not erase
            # working environment/runtime credentials.
            return

        desired_api_id = snapshot.api_id if snapshot.credentials_configured else self._fallback_api_id
        desired_api_hash = snapshot.api_hash if snapshot.credentials_configured else self._fallback_api_hash
        desired_session = snapshot.session_string if snapshot.session_configured else self._fallback_session_string
        override_active = bool(snapshot.credentials_configured or snapshot.session_configured)

        changed = (
            self.settings.telegram_api_id != desired_api_id
            or self.settings.telegram_api_hash != desired_api_hash
            or self.settings.telegram_session_string != desired_session
            or self._admin_override_active != override_active
        )
        if not changed:
            self._admin_override_active = override_active
            return

        async with self._lock:
            if self.service is not None:
                await self.service.disconnect()
                self.service = None
            self.settings.telegram_api_id = desired_api_id
            self.settings.telegram_api_hash = desired_api_hash
            self.settings.telegram_session_string = desired_session
            # Admin-managed session is authoritative over an older ad-hoc runtime
            # attach. A fresh attach can still be made explicitly afterwards.
            self._runtime_session_string = None
            self._admin_override_active = override_active

    async def _ensure_mtproto_monitor(self) -> bool:
        await self._refresh_admin_credentials()
        return await super()._ensure_mtproto_monitor()

    async def get_service(self):
        await self._refresh_admin_credentials()
        return await super().get_service()

    async def attach_session(self, session_string: str) -> dict[str, Any]:
        await self._refresh_admin_credentials(force=True)
        return await super().attach_session(session_string)

    def status(self) -> dict[str, Any]:
        result = super().status()
        result["admin_integrations"] = {
            "override_active": self._admin_override_active,
            "last_refresh_at": self._admin_last_refresh_at,
            "last_error": self._admin_last_error,
            "refresh_seconds": int(self._admin_refresh_seconds),
        }
        return result
