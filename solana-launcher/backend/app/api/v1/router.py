from fastapi import APIRouter

from app.api.v1 import (
    advanced_intelligence,
    analytics,
    auth,
    health,
    intelligence_memory,
    kols,
    kols_backtest,
    kols_coverage,
    kols_internal,
    subscriptions,
    tasks,
    telegram_intelligence,
    teragram_invite,
    users,
)

api_router = APIRouter()
api_router.include_router(analytics.router, prefix="/analytics", tags=["analytics"])
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(subscriptions.router, prefix="/subscriptions", tags=["subscriptions"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(tasks.router, prefix="/tasks", tags=["tasks"])
api_router.include_router(kols_internal.router, prefix="/kols", tags=["kol-intelligence-internal"])
api_router.include_router(kols_coverage.router, prefix="/kols", tags=["kol-trade-coverage-internal"])
api_router.include_router(kols_backtest.router, prefix="/kols", tags=["kol-backtest-internal"])
api_router.include_router(kols.router, prefix="/kols", tags=["kol-intelligence"])
api_router.include_router(
    telegram_intelligence.router,
    prefix="/telegram",
    tags=["telegram-intelligence"],
)
api_router.include_router(
    teragram_invite.router,
    prefix="/telegram/teragram",
    tags=["telegram-teragram"],
)
api_router.include_router(
    telegram_intelligence.social_router,
    prefix="/social",
    tags=["social-intelligence"],
)
api_router.include_router(
    intelligence_memory.router,
    prefix="/social/intelligence",
    tags=["intelligence-memory"],
)
api_router.include_router(
    advanced_intelligence.router,
    prefix="/social/intelligence/advanced",
    tags=["advanced-intelligence"],
)
api_router.include_router(health.router, tags=["health"])
