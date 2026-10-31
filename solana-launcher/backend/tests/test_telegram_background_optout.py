from types import SimpleNamespace
from unittest.mock import patch

from app.services.telegram_runtime import TelegramMonitorManager


def test_api_only_recovery_does_not_schedule_collectors():
    manager = TelegramMonitorManager.__new__(TelegramMonitorManager)
    manager.settings = SimpleNamespace(telegram_background_enabled=False)
    manager._background_task = None
    with patch("app.services.telegram_runtime.asyncio.create_task") as schedule:
        manager.start_background()
    schedule.assert_not_called()
    assert manager._background_task is None
