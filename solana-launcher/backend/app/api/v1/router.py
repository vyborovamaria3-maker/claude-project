from fastapi import APIRouter, Depends

from app.api.deps import get_current_user
from app.api.v1 import analytics, auth, health, subscriptions, tasks, telegram_intelligence, users

api_router = APIRouter()
api_router.include_router(
    analytics.router,
    prefix="/analytics",
    tags=["analytics"],
    dependencies=[Depends(get_current_user)],
)
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(subscriptions.router, prefix="/subscriptions", tags=["subscriptions"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(tasks.router, prefix="/tasks", tags=["tasks"])
api_router.include_router(
    telegram_intelligence.router,
    prefix="/telegram",
    tags=["telegram-intelligence"],
    dependencies=[Depends(get_current_user)],
)
# social_router mixes subscriber reads with the internal X ingestion endpoint.
# Read routes enforce get_current_user inside the module; /x/ingest keeps its
# separate BACKEND_API_KEY authentication and must not require a user JWT.
api_router.include_router(
    telegram_intelligence.social_router,
    prefix="/social",
    tags=["social-intelligence"],
)
api_router.include_router(health.router, tags=["health"])
