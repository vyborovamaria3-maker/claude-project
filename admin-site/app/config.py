from __future__ import annotations

import ipaddress
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


@dataclass(frozen=True)
class DataSourceConfig:
    id: str
    label: str
    kind: str
    dsn: str
    role: str = "generic"
    schema: str = "public"
    enabled: bool = True

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "DataSourceConfig":
        source_id = str(value.get("id", "")).strip()
        label = str(value.get("label", source_id)).strip()
        kind = str(value.get("kind", "sqlite")).strip().lower()
        dsn = os.path.expandvars(str(value.get("dsn", "")).strip())
        role = str(value.get("role", "generic")).strip().lower()
        schema = str(value.get("schema", "public")).strip()
        if not source_id or not label or not dsn:
            raise ValueError("Every data source requires id, label and dsn")
        if kind not in {"sqlite", "postgres"}:
            raise ValueError(f"Unsupported source kind: {kind}")
        return cls(source_id, label, kind, dsn, role, schema, bool(value.get("enabled", True)))


@dataclass(frozen=True)
class LogConfig:
    id: str
    label: str
    path: str

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "LogConfig":
        log_id = str(value.get("id", "")).strip()
        label = str(value.get("label", log_id)).strip()
        path = str(value.get("path", "")).strip()
        if not log_id or not path:
            raise ValueError("Every log source requires id and path")
        return cls(log_id, label, path)


@dataclass
class Settings:
    app_name: str = "POTAPoff Administrator"
    environment: str = "production"
    admin_username: str = "admin"
    admin_password: str = ""
    admin_password_hash: str = ""
    session_secret: str = ""
    session_cookie: str = "potapoff_admin_session"
    session_ttl_seconds: int = 8 * 60 * 60
    secure_cookie: bool = True
    audit_db_path: str = "/var/lib/potapoff-admin/audit.db"
    intelligence_db_path: str = "/data/intelligence/intelligence.sqlite3"
    sources: list[DataSourceConfig] = field(default_factory=list)
    logs: list[LogConfig] = field(default_factory=list)
    allowed_networks: list[ipaddress._BaseNetwork] = field(default_factory=list)
    solana_rpc_url: str = "https://api.mainnet-beta.solana.com"
    max_page_size: int = 250
    max_export_rows: int = 10_000
    show_sensitive: bool = False
    trust_proxy: bool = False
    trusted_proxy_hops: int = 1
    allowed_origins: list[str] = field(default_factory=list)

    @classmethod
    def load(cls) -> "Settings":
        sources = _load_json_items("ADMIN_SOURCES_FILE", "ADMIN_DATA_SOURCES")
        logs = _load_json_items("ADMIN_LOGS_FILE", "ADMIN_LOG_SOURCES")
        networks: list[ipaddress._BaseNetwork] = []
        for raw in os.getenv("ADMIN_ALLOWED_NETWORKS", "").split(","):
            value = raw.strip()
            if value:
                networks.append(ipaddress.ip_network(value, strict=False))

        return cls(
            app_name=os.getenv("ADMIN_APP_NAME", "POTAPoff Administrator"),
            environment=os.getenv("ADMIN_ENVIRONMENT", "production"),
            admin_username=os.getenv("ADMIN_USERNAME", "admin"),
            admin_password=os.getenv("ADMIN_PASSWORD", ""),
            admin_password_hash=os.getenv("ADMIN_PASSWORD_HASH", ""),
            session_secret=os.getenv("ADMIN_SESSION_SECRET", ""),
            session_cookie=os.getenv("ADMIN_SESSION_COOKIE", "potapoff_admin_session"),
            session_ttl_seconds=int(os.getenv("ADMIN_SESSION_TTL_SECONDS", str(8 * 60 * 60))),
            secure_cookie=_as_bool(os.getenv("ADMIN_SECURE_COOKIE", "true")),
            audit_db_path=os.getenv("ADMIN_AUDIT_DB", "/var/lib/potapoff-admin/audit.db"),
            intelligence_db_path=os.getenv(
                "ADMIN_INTELLIGENCE_DB", "/data/intelligence/intelligence.sqlite3"
            ),
            sources=[DataSourceConfig.from_dict(item) for item in sources],
            logs=[LogConfig.from_dict(item) for item in logs],
            allowed_networks=networks,
            solana_rpc_url=os.getenv("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
            max_page_size=max(1, min(int(os.getenv("ADMIN_MAX_PAGE_SIZE", "250")), 1000)),
            max_export_rows=max(1, min(int(os.getenv("ADMIN_MAX_EXPORT_ROWS", "10000")), 100_000)),
            show_sensitive=_as_bool(os.getenv("ADMIN_SHOW_SENSITIVE", "false")),
            trust_proxy=_as_bool(os.getenv("ADMIN_TRUST_PROXY", "false")),
            trusted_proxy_hops=max(1, min(int(os.getenv("ADMIN_TRUSTED_PROXY_HOPS", "1")), 10)),
            allowed_origins=[item.strip().rstrip("/") for item in os.getenv("ADMIN_ALLOWED_ORIGINS", "").split(",") if item.strip()],
        )

    def validate(self) -> None:
        if not self.session_secret or len(self.session_secret) < 32:
            raise RuntimeError("ADMIN_SESSION_SECRET must contain at least 32 characters")
        if self.environment.lower() == "production" and self.show_sensitive:
            raise RuntimeError("ADMIN_SHOW_SENSITIVE cannot be enabled in production")
        if self.environment.lower() == "production" and not self.allowed_origins:
            raise RuntimeError("ADMIN_ALLOWED_ORIGINS must be configured in production")
        for origin in self.allowed_origins:
            parsed = urlparse(origin)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
                raise RuntimeError(f"Invalid ADMIN_ALLOWED_ORIGINS value: {origin}")
        if not self.admin_password_hash and not self.admin_password:
            raise RuntimeError("Set ADMIN_PASSWORD_HASH (recommended) or ADMIN_PASSWORD")
        if self.session_ttl_seconds < 300 or self.session_ttl_seconds > 24 * 60 * 60:
            raise RuntimeError("ADMIN_SESSION_TTL_SECONDS must be between 300 and 86400")
        if self.environment.lower() == "production" and not Path(self.intelligence_db_path).is_absolute():
            raise RuntimeError("ADMIN_INTELLIGENCE_DB must be an absolute path in production")
        parsed_rpc = urlparse(self.solana_rpc_url)
        if parsed_rpc.scheme not in ({"https"} if self.environment.lower() == "production" else {"http", "https"}):
            raise RuntimeError("SOLANA_RPC_URL must use an allowed HTTP scheme")
        if not parsed_rpc.hostname or parsed_rpc.username or parsed_rpc.password:
            raise RuntimeError("SOLANA_RPC_URL is invalid")
        ids = [source.id for source in self.sources]
        if len(ids) != len(set(ids)):
            raise RuntimeError("Data source ids must be unique")
        log_ids = [item.id for item in self.logs]
        if len(log_ids) != len(set(log_ids)):
            raise RuntimeError("Log source ids must be unique")


def _as_bool(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _load_json_items(file_env: str, inline_env: str) -> list[dict[str, Any]]:
    file_name = os.getenv(file_env, "").strip()
    raw = ""
    if file_name:
        raw = Path(file_name).read_text(encoding="utf-8")
    else:
        raw = os.getenv(inline_env, "[]")
    parsed = json.loads(raw or "[]")
    if not isinstance(parsed, list):
        raise ValueError(f"{file_env}/{inline_env} must contain a JSON array")
    return [item for item in parsed if isinstance(item, dict)]
