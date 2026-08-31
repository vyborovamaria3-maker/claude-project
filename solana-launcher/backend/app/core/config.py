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
    debug: bool = Field(default=True, alias="DEBUG")
    secret_key: str = Field(alias="SECRET_KEY")
    subscription_password_encryption_key: str = Field(
        default="",
        alias="SUBSCRIPTION_PASSWORD_ENCRYPTION_KEY",
    )
    access_token_expire_minutes: int = Field(default=1440, alias="ACCESS_TOKEN_EXPIRE_MINUTES")
    algorithm: str = Field(default="HS256", alias="ALGORITHM")
    api_v1_prefix: str = Field(default="/api/v1", alias="API_V1_PREFIX")
    database_url: str = Field(
        default="postgresql+asyncpg://potapoff:potapoff@postgres:5432/potapoff",
        alias="DATABASE_URL",
    )
    redis_url: str = Field(default="redis://redis:6379/0", alias="REDIS_URL")
    celery_broker_url: str = Field(
        default="amqp://guest:guest@rabbitmq:5672//",
        alias="CELERY_BROKER_URL",
    )
    celery_result_backend: str = Field(default="redis://redis:6379/1", alias="CELERY_RESULT_BACKEND")
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
    admin_password: str = Field(default="ChangeMe123!", alias="ADMIN_PASSWORD")
    admin_display_name: str = Field(default="POTAPoff Admin", alias="ADMIN_DISPLAY_NAME")
    admin_session_secret: str = Field(default="admin-session-secret", alias="ADMIN_SESSION_SECRET")
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
    phantom_nonce_ttl_minutes: int = Field(default=5, alias="PHANTOM_NONCE_TTL_MINUTES")
    telegram_auth_max_age_hours: int = Field(default=24, alias="TELEGRAM_AUTH_MAX_AGE_HOURS")
    auth_rate_limit_window_seconds: int = Field(default=60, alias="AUTH_RATE_LIMIT_WINDOW_SECONDS")
    auth_nonce_rate_limit: int = Field(default=5, alias="AUTH_NONCE_RATE_LIMIT")
    auth_verify_rate_limit: int = Field(default=10, alias="AUTH_VERIFY_RATE_LIMIT")
    pumpfun_api_base: str = Field(default="https://frontend-api.pump.fun", alias="PUMPFUN_API_BASE")
    raydium_api_base: str = Field(default="https://api.raydium.io/v3", alias="RAYDIUM_API_BASE")
    birdeye_api_base: str = Field(default="https://public-api.birdeye.so", alias="BIRDEYE_API_BASE")
    birdeye_api_key: str = Field(default="", alias="BIRDEYE_API_KEY")
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
    backend_api_key: str = Field(default="", alias="BACKEND_API_KEY")

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
    def validate_production_secrets(self) -> "Settings":
        if self.environment.strip().lower() not in {"production", "prod"}:
            return self

        password = self.admin_password.strip()
        session_secret = self.admin_session_secret.strip()
        encryption_key = self.subscription_password_encryption_key.strip()
        if not password or password == "ChangeMe123!" or len(password) < 16:
            raise ValueError("ADMIN_PASSWORD must be explicitly configured with at least 16 characters in production")
        if not session_secret or session_secret == "admin-session-secret" or len(session_secret) < 32:
            raise ValueError("ADMIN_SESSION_SECRET must be explicitly configured with at least 32 characters in production")
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
