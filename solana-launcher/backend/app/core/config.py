from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


_BACKEND_ENV = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_BACKEND_ENV),
        env_file_encoding="utf-8-sig",
        extra="ignore",
        populate_by_name=True,
    )

    app_name: str = Field(default="POTAPoff API", alias="APP_NAME")
    environment: str = Field(default="development", alias="ENVIRONMENT")
    debug: bool = Field(default=False, alias="DEBUG")
    secret_key: str = Field(alias="SECRET_KEY")
    subscription_password_encryption_key: str = Field(
        default="",
        alias="SUBSCRIPTION_PASSWORD_ENCRYPTION_KEY",
    )
    access_token_expire_minutes: int = Field(default=1440, alias="ACCESS_TOKEN_EXPIRE_MINUTES")
    algorithm: str = Field(default="HS256", alias="ALGORITHM")
    api_v1_prefix: str = Field(default="/api/v1", alias="API_V1_PREFIX")
    # Local-only fallbacks contain no network credentials. Production Compose
    # explicitly injects authenticated service URLs.
    database_url: str = Field(
        default="sqlite+aiosqlite:///./potapoff.db",
        alias="DATABASE_URL",
    )
    redis_url: str = Field(default="redis://127.0.0.1:6379/0", alias="REDIS_URL")
    celery_broker_url: str = Field(
        default="amqp://127.0.0.1:5672//",
        alias="CELERY_BROKER_URL",
    )
    celery_result_backend: str = Field(
        default="redis://127.0.0.1:6379/1",
        alias="CELERY_RESULT_BACKEND",
    )
    redis_cache_db: int = Field(default=2, alias="REDIS_CACHE_DB")
    cors_origins: list[str] = Field(
        default_factory=lambda: [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:3001",
            "http://127.0.0.1:3001",
        ],
        alias="CORS_ORIGINS",
    )
    admin_username: str = Field(default="admin@potapoff.local", alias="ADMIN_USERNAME")
    # No source-controlled password/session credential is usable by default.
    # Development does not auto-provision an administrator.
    admin_password: str = Field(default="", alias="ADMIN_PASSWORD")
    admin_display_name: str = Field(default="POTAPoff Admin", alias="ADMIN_DISPLAY_NAME")
    admin_session_secret: str = Field(default="", alias="ADMIN_SESSION_SECRET")
    frontend_url: str = Field(default="http://localhost:3001", alias="FRONTEND_URL")
    frontend_internal_url: str = Field(default="http://frontend:3000", alias="FRONTEND_INTERNAL_URL")
    telegram_bot_token: str = Field(default="", alias="TELEGRAM_BOT_TOKEN")
    telegram_api_id: int | None = Field(default=None, alias="TG_API_ID")
    telegram_api_hash: str = Field(default="", alias="TG_API_HASH")
    telegram_session_string: str = Field(default="", alias="TG_SESSION_STRING")
    telegram_session_path: str = Field(default="data/telegram-intelligence", alias="TG_SESSION_PATH")
    telegram_monitor_channels: str = Field(default="", alias="TG_MONITOR_CHANNELS")
    telegram_autostart: bool = Field(default=False, alias="TG_AUTOSTART")
    telegram_history_limit: int = Field(default=300, ge=1, le=5000, alias="TG_HISTORY_LIMIT")
    telegram_graph_depth: int = Field(default=1, ge=0, le=3, alias="TG_GRAPH_DEPTH")
    telegram_entity_limit: int = Field(default=100, ge=1, le=1000, alias="TG_ENTITY_LIMIT")
    telegram_evaluate_interval_seconds: int = Field(default=300, ge=60, alias="TG_EVALUATE_INTERVAL_SECONDS")
    telegram_public_web_enabled: bool = Field(default=False, alias="TG_PUBLIC_WEB_ENABLED")
    telegram_public_web_channels: str = Field(default="", alias="TG_PUBLIC_WEB_CHANNELS")
    telegram_public_web_history_limit: int = Field(default=100, ge=1, le=500, alias="TG_PUBLIC_WEB_HISTORY_LIMIT")
    telegram_public_web_timeout_seconds: float = Field(default=12.0, ge=2.0, le=60.0, alias="TG_PUBLIC_WEB_TIMEOUT_SECONDS")
    telegram_public_web_discovery_enabled: bool = Field(default=True, alias="TG_PUBLIC_WEB_DISCOVERY_ENABLED")
    telegram_public_web_discovery_depth: int = Field(default=2, ge=0, le=3, alias="TG_PUBLIC_WEB_DISCOVERY_DEPTH")
    telegram_public_web_discovery_entity_limit: int = Field(default=25, ge=1, le=500, alias="TG_PUBLIC_WEB_DISCOVERY_ENTITY_LIMIT")
    telegram_public_web_discovery_history_limit: int = Field(default=40, ge=10, le=200, alias="TG_PUBLIC_WEB_DISCOVERY_HISTORY_LIMIT")
    telegram_public_web_relevance_min_score: float = Field(default=35.0, ge=0.0, le=100.0, alias="TG_PUBLIC_WEB_RELEVANCE_MIN_SCORE")
    telegram_public_web_seed_database: str = Field(default="data/tgdataset/telegram_seed_database.json", alias="TG_PUBLIC_WEB_SEED_DATABASE")
    telegram_public_web_seed_database_limit: int = Field(default=12, ge=0, le=100, alias="TG_PUBLIC_WEB_SEED_DATABASE_LIMIT")
    telegram_public_web_refresh_enabled: bool = Field(default=True, alias="TG_PUBLIC_WEB_REFRESH_ENABLED")
    telegram_public_web_refresh_tick_seconds: int = Field(default=60, ge=30, le=3600, alias="TG_PUBLIC_WEB_REFRESH_TICK_SECONDS")
    telegram_public_web_refresh_batch_size: int = Field(default=25, ge=1, le=200, alias="TG_PUBLIC_WEB_REFRESH_BATCH_SIZE")
    telegram_public_web_refresh_strong_seconds: int = Field(default=600, ge=60, alias="TG_PUBLIC_WEB_REFRESH_STRONG_SECONDS")
    telegram_public_web_refresh_normal_seconds: int = Field(default=1800, ge=60, alias="TG_PUBLIC_WEB_REFRESH_NORMAL_SECONDS")
    telegram_public_web_refresh_rejected_seconds: int = Field(default=21600, ge=300, alias="TG_PUBLIC_WEB_REFRESH_REJECTED_SECONDS")
    telegram_public_web_refresh_unavailable_seconds: int = Field(default=3600, ge=300, alias="TG_PUBLIC_WEB_REFRESH_UNAVAILABLE_SECONDS")
    phantom_nonce_ttl_minutes: int = Field(default=5, alias="PHANTOM_NONCE_TTL_MINUTES")
    telegram_auth_max_age_hours: int = Field(default=24, alias="TELEGRAM_AUTH_MAX_AGE_HOURS")
    auth_rate_limit_window_seconds: int = Field(default=60, alias="AUTH_RATE_LIMIT_WINDOW_SECONDS")
    auth_nonce_rate_limit: int = Field(default=5, alias="AUTH_NONCE_RATE_LIMIT")
    auth_verify_rate_limit: int = Field(default=10, alias="AUTH_VERIFY_RATE_LIMIT")
    pumpfun_api_base: str = Field(default="https://frontend-api.pump.fun", alias="PUMPFUN_API_BASE")
    raydium_api_base: str = Field(default="https://api.raydium.io/v3", alias="RAYDIUM_API_BASE")
    birdeye_api_base: str = Field(default="https://public-api.birdeye.so", alias="BIRDEYE_API_BASE")
    birdeye_api_key: str = Field(default="", alias="BIRDEYE_API_KEY")
    birdeye_request_concurrency: int = Field(default=12, ge=1, le=64, alias="BIRDEYE_REQUEST_CONCURRENCY")
    birdeye_token_batch_size: int = Field(default=100, ge=1, le=1000, alias="BIRDEYE_TOKEN_BATCH_SIZE")
    birdeye_timeout_seconds: float = Field(default=20.0, ge=1.0, le=120.0, alias="BIRDEYE_TIMEOUT_SECONDS")
    birdeye_max_retries: int = Field(default=3, ge=0, le=8, alias="BIRDEYE_MAX_RETRIES")
    birdeye_backoff_base_seconds: float = Field(default=0.5, ge=0.01, le=10.0, alias="BIRDEYE_BACKOFF_BASE_SECONDS")
    birdeye_backoff_max_seconds: float = Field(default=8.0, ge=0.1, le=60.0, alias="BIRDEYE_BACKOFF_MAX_SECONDS")
    helius_rpc_url: str = Field(default="", alias="HELIUS_RPC_URL")
    solana_rpc_url: str = Field(default="https://api.mainnet-beta.solana.com", alias="SOLANA_RPC_URL")
    twitter_username: str = Field(default="", alias="TWITTER_USERNAME")
    twitter_password: str = Field(default="", alias="TWITTER_PASSWORD")
    twitter_email: str = Field(default="", alias="TWITTER_EMAIL")
    pumpportal_ws_url: str = Field(default="", alias="PUMPPORTAL_WS_URL")
    helius_ws_url: str = Field(default="", alias="HELIUS_WS_URL")
    collector_refresh_seconds: int = Field(default=300, alias="COLLECTOR_REFRESH_SECONDS")
    collector_metric_refresh_seconds: int = Field(default=3600, alias="COLLECTOR_METRIC_REFRESH_SECONDS")
    collector_insider_refresh_seconds: int = Field(default=86400, alias="COLLECTOR_INSIDER_REFRESH_SECONDS")

    # BACKEND_API_KEY is reserved for intelligence ingestion/research endpoints.
    backend_api_key: str = Field(default="", alias="BACKEND_API_KEY")
    # Mini App checkout/order operations use a credential that is not valid for
    # intelligence APIs or privileged subscription administration.
    subscription_internal_key: str = Field(default="", alias="SUBSCRIPTION_INTERNAL_KEY")
    # The main admin gets its own key. It can update subscription settings but
    # is never injected into the public-facing Next.js application container.
    subscription_admin_key: str = Field(default="", alias="SUBSCRIPTION_ADMIN_KEY")
    # Only the API process needs the checkout/admin credentials. Worker
    # processes can keep these false and start without receiving either key.
    require_subscription_internal_key: bool = Field(
        default=False,
        alias="REQUIRE_SUBSCRIPTION_INTERNAL_KEY",
    )
    require_subscription_admin_key: bool = Field(
        default=False,
        alias="REQUIRE_SUBSCRIPTION_ADMIN_KEY",
    )

    @field_validator("telegram_api_id", mode="before")
    @classmethod
    def normalize_optional_telegram_api_id(cls, v):
        if isinstance(v, str) and not v.strip():
            return None
        return v

    @field_validator("secret_key", mode="after")
    @classmethod
    def validate_secret_key(cls, v: str) -> str:
        if len(v) < 32:
            raise ValueError("SECRET_KEY must be at least 32 characters long. Generate a strong key with: openssl rand -hex 32")
        weak_patterns = ["change-me", "changeme", "secret", "default", "password", "123456", "admin"]
        v_lower = v.lower()
        if any(pattern in v_lower for pattern in weak_patterns):
            raise ValueError("SECRET_KEY contains weak pattern. Do not use default or predictable secrets.")
        return v

    @model_validator(mode="after")
    def validate_runtime_security(self) -> "Settings":
        is_production = self.environment.strip().lower() in {"production", "prod"}

        # Local/test sessions still need a non-empty signing secret, but there is
        # no committed standalone session credential. Production must configure a
        # distinct secret below.
        if not is_production and not self.admin_session_secret.strip():
            self.admin_session_secret = self.secret_key
            return self

        if not is_production:
            return self

        password = self.admin_password.strip()
        session_secret = self.admin_session_secret.strip()
        backend_api_key = self.backend_api_key.strip()
        subscription_internal_key = self.subscription_internal_key.strip()
        subscription_admin_key = self.subscription_admin_key.strip()
        encryption_key = self.subscription_password_encryption_key.strip()
        if self.debug:
            raise ValueError("DEBUG must be false in production")
        if not password or len(password) < 16:
            raise ValueError("ADMIN_PASSWORD must be explicitly configured with at least 16 characters in production")
        if not session_secret or len(session_secret) < 32:
            raise ValueError("ADMIN_SESSION_SECRET must be explicitly configured with at least 32 characters in production")
        if session_secret == self.secret_key:
            raise ValueError("ADMIN_SESSION_SECRET must be different from SECRET_KEY in production")
        if not backend_api_key or len(backend_api_key) < 32:
            raise ValueError("BACKEND_API_KEY must be explicitly configured with at least 32 characters in production")
        if self.require_subscription_internal_key and (
            not subscription_internal_key or len(subscription_internal_key) < 32
        ):
            raise ValueError("SUBSCRIPTION_INTERNAL_KEY must be explicitly configured with at least 32 characters for the API service")
        if subscription_internal_key and len(subscription_internal_key) < 32:
            raise ValueError("SUBSCRIPTION_INTERNAL_KEY must be at least 32 characters when configured")
        if self.require_subscription_admin_key and (
            not subscription_admin_key or len(subscription_admin_key) < 32
        ):
            raise ValueError("SUBSCRIPTION_ADMIN_KEY must be explicitly configured with at least 32 characters for the API service")
        if subscription_admin_key and len(subscription_admin_key) < 32:
            raise ValueError("SUBSCRIPTION_ADMIN_KEY must be at least 32 characters when configured")

        internal_keys = [backend_api_key]
        if subscription_internal_key:
            internal_keys.append(subscription_internal_key)
        if subscription_admin_key:
            internal_keys.append(subscription_admin_key)
        if len(set(internal_keys)) != len(internal_keys):
            raise ValueError("BACKEND_API_KEY, SUBSCRIPTION_INTERNAL_KEY and SUBSCRIPTION_ADMIN_KEY must be different credentials")
        if "*" in self.cors_origins:
            raise ValueError("Wildcard CORS origins are not allowed in production")
        if len(encryption_key) < 32:
            raise ValueError(
                "SUBSCRIPTION_PASSWORD_ENCRYPTION_KEY must be explicitly configured with at least 32 characters in production"
            )
        if encryption_key == self.secret_key:
            raise ValueError("SUBSCRIPTION_PASSWORD_ENCRYPTION_KEY must be different from SECRET_KEY")
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
