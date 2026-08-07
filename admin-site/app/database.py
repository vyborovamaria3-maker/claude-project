from __future__ import annotations

import contextlib
import csv
import io
import json
import re
import sqlite3
from pathlib import Path
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Iterator
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .config import DataSourceConfig

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")
SENSITIVE_TOKENS = (
    "password",
    "hashed_password",
    "secret",
    "private",
    "mnemonic",
    "seed",
    "api_key",
    "apikey",
    "access_token",
    "refresh_token",
    "session",
    "cookie",
    "authorization",
    "init_data",
)


def _quote(identifier: str) -> str:
    if not _IDENTIFIER.fullmatch(identifier):
        raise ValueError("Unsafe database identifier")
    return f'"{identifier}"'


def _json_value(value: Any) -> Any:
    if isinstance(value, bytes):
        return f"<binary {len(value)} bytes>"
    if isinstance(value, Decimal):
        return str(value)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    try:
        json.dumps(value)
        return value
    except TypeError:
        return str(value)


def is_sensitive(column: str) -> bool:
    normalized = column.strip().lower()
    return any(token in normalized for token in SENSITIVE_TOKENS)


def _csv_safe(value: Any) -> Any:
    if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + value
    return value


def _mask_nested(value: Any, *, show_sensitive: bool) -> Any:
    if isinstance(value, dict):
        return {
            str(key): ("••••••" if is_sensitive(str(key)) and not show_sensitive and item not in (None, "")
                       else _mask_nested(item, show_sensitive=show_sensitive))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_mask_nested(item, show_sensitive=show_sensitive) for item in value]
    if isinstance(value, tuple):
        return [_mask_nested(item, show_sensitive=show_sensitive) for item in value]
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return value
        if isinstance(parsed, (dict, list)):
            return _mask_nested(parsed, show_sensitive=show_sensitive)
    return _json_value(value)


@dataclass
class ColumnInfo:
    name: str
    type: str
    nullable: bool = True
    primary_key: bool = False


class DataSource:
    def __init__(self, config: DataSourceConfig, *, show_sensitive: bool = False) -> None:
        self.config = config
        self.show_sensitive = show_sensitive

    @contextlib.contextmanager
    def connect(self) -> Iterator[Any]:
        if self.config.kind == "sqlite":
            raw_dsn = self.config.dsn
            if raw_dsn == ":memory:":
                raise RuntimeError("In-memory SQLite is not allowed for product data sources")
            if raw_dsn.startswith("file:"):
                parts = urlsplit(raw_dsn)
                query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True) if key.lower() != "mode"]
                query.append(("mode", "ro"))
                dsn = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))
            else:
                dsn = f"file:{Path(raw_dsn).expanduser().resolve()}?mode=ro"
            db = sqlite3.connect(dsn, uri=True, timeout=5)
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA query_only=ON")
            try:
                yield db
            finally:
                db.close()
            return

        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:
            raise RuntimeError("PostgreSQL support requires psycopg[binary]") from exc
        with psycopg.connect(
            self.config.dsn,
            row_factory=dict_row,
            connect_timeout=5,
            options="-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000",
        ) as db:
            with db.cursor() as cur:
                cur.execute("SET TRANSACTION READ ONLY")
            yield db

    def health(self) -> dict[str, Any]:
        try:
            with self.connect() as db:
                cursor = db.execute("SELECT 1") if self.config.kind == "sqlite" else db.execute("SELECT 1")
                cursor.fetchone()
            return {"ok": True, "error": None}
        except Exception as exc:
            return {"ok": False, "error": str(exc)[:400]}

    def tables(self) -> list[str]:
        with self.connect() as db:
            if self.config.kind == "sqlite":
                rows = db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                ).fetchall()
                return [str(row[0]) for row in rows]
            rows = db.execute(
                "SELECT table_name FROM information_schema.tables WHERE table_schema=%s AND table_type='BASE TABLE' ORDER BY table_name",
                (self.config.schema,),
            ).fetchall()
            return [str(row["table_name"]) for row in rows]

    def columns(self, table: str) -> list[ColumnInfo]:
        self._require_table(table)
        with self.connect() as db:
            if self.config.kind == "sqlite":
                rows = db.execute(f"PRAGMA table_info({_quote(table)})").fetchall()
                return [
                    ColumnInfo(str(row[1]), str(row[2] or ""), not bool(row[3]), bool(row[5]))
                    for row in rows
                ]
            rows = db.execute(
                """
                SELECT column_name, data_type, is_nullable,
                       EXISTS (
                         SELECT 1 FROM information_schema.table_constraints tc
                         JOIN information_schema.key_column_usage kcu
                           ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
                         WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema=%s
                           AND tc.table_name=%s AND kcu.column_name=c.column_name
                       ) AS primary_key
                FROM information_schema.columns c
                WHERE table_schema=%s AND table_name=%s
                ORDER BY ordinal_position
                """,
                (self.config.schema, table, self.config.schema, table),
            ).fetchall()
            return [
                ColumnInfo(str(row["column_name"]), str(row["data_type"]), row["is_nullable"] == "YES", bool(row["primary_key"]))
                for row in rows
            ]

    def count(self, table: str) -> int:
        self._require_table(table)
        qualified = self._qualified(table)
        with self.connect() as db:
            row = db.execute(f"SELECT COUNT(*) AS count FROM {qualified}").fetchone()
            return int(row[0] if self.config.kind == "sqlite" else row["count"])

    def estimate_count(self, table: str) -> int:
        self._require_table(table)
        qualified = self._qualified(table)
        with self.connect() as db:
            if self.config.kind == "sqlite":
                try:
                    row = db.execute(f"SELECT MAX(rowid) AS count FROM {qualified}").fetchone()
                    return int(row[0] or 0)
                except sqlite3.DatabaseError:
                    row = db.execute(f"SELECT COUNT(*) AS count FROM {qualified}").fetchone()
                    return int(row[0] or 0)
            row = db.execute(
                "SELECT COALESCE(n_live_tup, 0)::bigint AS count FROM pg_stat_user_tables WHERE schemaname=%s AND relname=%s",
                (self.config.schema, table),
            ).fetchone()
            return int(row["count"] if row else 0)

    def rows(
        self,
        table: str,
        *,
        page: int = 1,
        page_size: int = 50,
        sort: str | None = None,
        order: str = "desc",
        search: str = "",
    ) -> dict[str, Any]:
        columns = self.columns(table)
        column_names = [column.name for column in columns]
        if not column_names:
            return {"rows": [], "columns": [], "page": 1, "page_size": page_size, "total": 0}
        sort_column = sort if sort in column_names else next((c.name for c in columns if c.primary_key), column_names[0])
        direction = "ASC" if order.lower() == "asc" else "DESC"
        page = max(1, page)
        page_size = max(1, page_size)
        offset = (page - 1) * page_size
        qualified = self._qualified(table)
        where = ""
        params: list[Any] = []
        if search.strip():
            searchable = [column.name for column in columns if not is_sensitive(column.name)][:12]
            if searchable:
                placeholder = "?" if self.config.kind == "sqlite" else "%s"
                operator = "LIKE" if self.config.kind == "sqlite" else "ILIKE"
                where = " WHERE " + " OR ".join(
                    f"CAST({_quote(name)} AS TEXT) {operator} {placeholder}" for name in searchable
                )
                params.extend([f"%{search.strip()}%"] * len(searchable))
        limit_placeholder = "?" if self.config.kind == "sqlite" else "%s"
        sql = (
            f"SELECT * FROM {qualified}{where} ORDER BY {_quote(sort_column)} {direction} "
            f"LIMIT {limit_placeholder} OFFSET {limit_placeholder}"
        )
        count_sql = f"SELECT COUNT(*) AS count FROM {qualified}{where}"
        with self.connect() as db:
            total_row = db.execute(count_sql, tuple(params)).fetchone()
            total = int(total_row[0] if self.config.kind == "sqlite" else total_row["count"])
            rows = db.execute(sql, tuple(params + [page_size, offset])).fetchall()
        normalized = [self._mask(dict(row)) for row in rows]
        return {
            "source": self.config.id,
            "table": table,
            "columns": [
                {"name": c.name, "type": c.type, "nullable": c.nullable, "primary_key": c.primary_key, "sensitive": is_sensitive(c.name)}
                for c in columns
            ],
            "rows": normalized,
            "page": page,
            "page_size": page_size,
            "total": total,
            "sort": sort_column,
            "order": direction.lower(),
        }

    def export_csv(self, table: str, *, limit: int) -> str:
        result = self.rows(table, page=1, page_size=limit, order="asc")
        names = [column["name"] for column in result["columns"]]
        stream = io.StringIO()
        writer = csv.DictWriter(stream, fieldnames=names, extrasaction="ignore")
        writer.writeheader()
        for row in result["rows"]:
            writer.writerow({key: _csv_safe(value) for key, value in row.items()})
        return stream.getvalue()

    def recent(self, table: str, *, limit: int = 100) -> list[dict[str, Any]]:
        columns = self.columns(table)
        names = [column.name for column in columns]
        sort = next(
            (name for name in ("created_at", "createdAt", "updated_at", "timestamp", "id") if name in names),
            names[0] if names else None,
        )
        if not sort:
            return []
        return self.rows(table, page=1, page_size=limit, sort=sort, order="desc")["rows"]

    def _qualified(self, table: str) -> str:
        if self.config.kind == "postgres":
            return f"{_quote(self.config.schema)}.{_quote(table)}"
        return _quote(table)

    def _require_table(self, table: str) -> None:
        if table not in self.tables():
            raise ValueError("Unknown table")

    def _mask(self, row: dict[str, Any]) -> dict[str, Any]:
        output: dict[str, Any] = {}
        for key, value in row.items():
            if is_sensitive(key) and not self.show_sensitive:
                output[key] = "••••••" if value not in (None, "") else value
            else:
                output[key] = _mask_nested(value, show_sensitive=self.show_sensitive)
        return output


class SourceRegistry:
    def __init__(self, configs: list[DataSourceConfig], *, show_sensitive: bool = False) -> None:
        self._sources = {cfg.id: DataSource(cfg, show_sensitive=show_sensitive) for cfg in configs if cfg.enabled}

    def get(self, source_id: str) -> DataSource:
        try:
            return self._sources[source_id]
        except KeyError:
            raise ValueError("Unknown data source") from None

    def all(self) -> list[DataSource]:
        return list(self._sources.values())
