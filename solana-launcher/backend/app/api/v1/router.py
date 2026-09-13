from fastapi import APIRouter

from app.api.v1 import (
    advanced_intelligence,
    analytics,
    auth,
    health,
    intelligence_memory,
    subscriptions,
    tasks,
    telegram_intelligence,
    twitter_crawler_admin,
    twitter_registry_admin,
    twitter_registry_admin_compat,
    users,
)

api_router = APIRouter()
api_router.include_router(analytics.router, prefix="/analytics", tags=["analytics"])
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(subscriptions.router, prefix="/subscriptions", tags=["subscriptions"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(tasks.router, prefix="/tasks", tags=["tasks"])
api_router.include_router(
    telegram_intelligence.router,
    prefix="/telegram",
    tags=["telegram-intelligence"],
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
api_router.include_router(
    twitter_crawler_admin.router,
    prefix="/twitter/admin",
    tags=["twitter-crawler-admin"],
)
# The Next admin proxy targets /api/v1/admin/twitter-registry/*.
# Compatibility routes must be registered first so overview/config/runs/actions
# use the canonical crawler settings/run tables rather than the legacy tables.
api_router.include_router(
    twitter_registry_admin_compat.router,
    prefix="/admin/twitter-registry",
    tags=["twitter-registry-admin"],
)
api_router.include_router(
    twitter_registry_admin.router,
    prefix="/admin/twitter-registry",
    tags=["twitter-registry-admin"],
)
api_router.include_router(health.router, tags=["health"])
