"""Authenticated, read-only checks of the actual persistence destinations."""
from fastapi import APIRouter, Depends, HTTPException, Request

from .auth import require_admin
from .subscription_admin import _backend_request
from .x_collector_admin import connection


def collector_status():
    try:
        with connection() as db:
            db.execute("SELECT 1 FROM public.x_tasks LIMIT 0")
            db.execute("SELECT 1 FROM public.twitter_tweets LIMIT 0")
        return "Чтение доступно"
    except HTTPException:
        return "Недоступно: проверьте ADMIN_X_COLLECTOR_DSN и таблицы коллектора"


def build_integration_router():
    router = APIRouter()

    @router.get("/api/integrations")
    async def integrations(request: Request, admin=Depends(require_admin)):
        from starlette.concurrency import run_in_threadpool

        collector = await run_in_threadpool(collector_status)
        try:
            settings = await _backend_request("GET")
            required = {"monthly_price_sol", "monthly_price_usdt", "free_demo_enabled", "demo_days", "solana_recipient_wallet"}
            if not required.issubset(settings):
                raise HTTPException(502, "Invalid settings response")
            subscription = "Чтение доступно"
        except HTTPException:
            subscription = "Недоступно: проверьте POTAPOFF_BACKEND_URL и ключ подписки"
        state = request.app.state.mutable_state_backend
        return {"rows": [
            {"Раздел": "Подписка / Mini App", "Куда сохраняется": "База основного сайта через API", "Применение": "Сайт и Mini App используют эти настройки", "Состояние": subscription},
            {"Раздел": "X Collector", "Куда сохраняется": "PostgreSQL коллектора, транзакция", "Применение": "Исходные таблицы доступны коллектору; сводки обновляет планировщик", "Состояние": collector},
            {"Раздел": "Базы данных", "Куда сохраняется": "Просмотр подключённых баз", "Применение": "Показывает данные сайта; редактирование отключено", "Состояние": "Проверка каждого источника во вкладке Базы данных"},
            {"Раздел": "Флаги, профили анализа, аудит", "Куда сохраняется": f"Хранилище админки: {state}", "Применение": "Локально для админки; сайт флаги и профили не читает", "Состояние": "Готовность хранилища: /api/ready"},
        ]}

    return router
