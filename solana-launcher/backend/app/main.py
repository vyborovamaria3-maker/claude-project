from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from starlette.middleware.sessions import SessionMiddleware
from redis.asyncio import Redis

from app.api.v1 import analytics
from app.api.v1.router import api_router
from app.admin import setup_admin
from app.core.config import Settings, get_settings
from app.core.rate_limit import RateLimiter
from app.db.base import Base
from app.db.session import create_engine_and_sessionmaker
from app.metrics import instrument_app
from app import models  # noqa: F401
from app.schemas.token import Message
from app.services.etl import get_or_create_jobs
from app.services.telegram_runtime import TelegramMonitorManager
from app.services.users import ensure_admin_user


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings: Settings = app.state.settings
    app.state.redis = Redis.from_url(settings.redis_url, decode_responses=True)
    app.state.rate_limiter = RateLimiter(app.state.redis)
    if settings.environment == "development" and settings.database_url.startswith("sqlite"):
        async with app.state.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    await ensure_admin_user(app.state.sessionmaker, settings)
    async with app.state.sessionmaker() as session:
        await get_or_create_jobs(session)

    if settings.telegram_autostart and settings.telegram_monitor_channels.strip():
        try:
            service = await app.state.telegram_intelligence.get_service()
            channels = [item.strip() for item in settings.telegram_monitor_channels.split(",") if item.strip()]
            if channels:
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
                await service.start_monitor(monitored)
        except Exception:
            # Telegram intelligence is optional; a stale/missing MTProto session must not prevent API startup.
            pass

    yield
    await app.state.telegram_intelligence.close()
    if app.state.redis is not None:
        await app.state.redis.aclose()
    await app.state.engine.dispose()


def create_app(
    settings: Settings | None = None,
    engine: AsyncEngine | None = None,
    sessionmaker: async_sessionmaker[AsyncSession] | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    if engine is None or sessionmaker is None:
        engine, sessionmaker = create_engine_and_sessionmaker(settings)

    app = FastAPI(title=settings.app_name, debug=settings.debug, lifespan=lifespan)
    app.state.settings = settings
    app.state.engine = engine
    app.state.sessionmaker = sessionmaker
    app.state.redis = None
    app.state.rate_limiter = RateLimiter(None)
    app.state.telegram_intelligence = TelegramMonitorManager(settings, sessionmaker)

    app.add_middleware(SessionMiddleware, secret_key=settings.admin_session_secret)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    setup_admin(app, engine, settings)
    app.include_router(analytics.router, prefix="/api")
    app.include_router(api_router, prefix=settings.api_v1_prefix)

    instrument_app(app)

    @app.get("/health", response_model=Message)
    async def root_health() -> Message:
        return Message(detail="ok")

    @app.get("/ready", response_model=Message)
    async def root_ready(request: Request) -> Message:
        sessionmaker = request.app.state.sessionmaker
        async with sessionmaker() as session:
            await session.execute(text("SELECT 1"))
        return Message(detail="ready")

    return app


app = create_app()
