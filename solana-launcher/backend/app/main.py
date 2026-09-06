import hmac
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from starlette.middleware.sessions import SessionMiddleware
from redis.asyncio import Redis

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

    # Never bootstrap a predictable development administrator. Production
    # configuration is already validated for strong explicit credentials.
    if settings.environment.strip().lower() in {"production", "prod"}:
        await ensure_admin_user(app.state.sessionmaker, settings)

    async with app.state.sessionmaker() as session:
        await get_or_create_jobs(session)

    # Telegram discovery/MTProto backfill is intentionally detached from startup.
    # Slow Telegram/network calls must never delay /health or the rest of the API.
    app.state.telegram_intelligence.start_background()

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

    is_production = settings.environment.strip().lower() in {"production", "prod"}
    app = FastAPI(
        title=settings.app_name,
        debug=settings.debug,
        lifespan=lifespan,
        docs_url=None if is_production else "/docs",
        redoc_url=None if is_production else "/redoc",
        openapi_url=None if is_production else "/openapi.json",
    )
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

    legacy_register_password_path = f"{settings.api_v1_prefix.rstrip('/')}/auth/register-password"

    @app.middleware("http")
    async def protect_legacy_password_provisioning(request: Request, call_next):
        if request.url.path != legacy_register_password_path:
            return await call_next(request)

        # The legacy paid-password provisioning route is intentionally absent
        # from production. Development/test use still requires a real secret;
        # a fixed source-controlled header must never authorize it.
        if is_production:
            return JSONResponse(status_code=404, content={"detail": "Not found"})

        expected_key = settings.backend_api_key.strip()
        supplied_key = request.headers.get("X-API-Key", "")
        if not expected_key:
            return JSONResponse(
                status_code=503,
                content={"detail": "Password provisioning is not configured"},
            )
        if not hmac.compare_digest(supplied_key.encode("utf-8"), expected_key.encode("utf-8")):
            return JSONResponse(status_code=403, content={"detail": "Invalid API key"})
        return await call_next(request)

    # The production control plane is admin-site. Keep SQLAdmin available only
    # for local/development diagnostics so it cannot bypass MFA/re-auth controls.
    if not is_production:
        setup_admin(app, engine, settings)

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
