from __future__ import annotations

import os
from typing import Any

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(value, maximum))


def build_postgres_pool(
    dsn: str,
    *,
    name: str,
    min_size: int | None = None,
    max_size: int | None = None,
    connect_timeout: int = 5,
) -> ConnectionPool:
    """Create a bounded synchronous pool tuned for FastAPI threadpool workloads."""
    if not isinstance(dsn, str) or not dsn.strip():
        raise ValueError("PostgreSQL DSN must be non-empty")
    minimum = min_size if min_size is not None else _bounded_int("ADMIN_PG_POOL_MIN", 1, 0, 16)
    maximum = max_size if max_size is not None else _bounded_int("ADMIN_PG_POOL_MAX", 6, 1, 32)
    maximum = max(minimum, maximum)
    return ConnectionPool(
        conninfo=dsn.strip(),
        kwargs={"row_factory": dict_row, "connect_timeout": connect_timeout},
        min_size=minimum,
        max_size=maximum,
        timeout=float(_bounded_int("ADMIN_PG_POOL_WAIT_SECONDS", 2, 1, 15)),
        max_idle=float(_bounded_int("ADMIN_PG_POOL_MAX_IDLE_SECONDS", 300, 30, 3600)),
        max_lifetime=float(_bounded_int("ADMIN_PG_POOL_MAX_LIFETIME_SECONDS", 1800, 300, 7200)),
        check=ConnectionPool.check_connection,
        name=name,
        open=True,
    )


def pooled_connection(pool: ConnectionPool | None, dsn: str, **kwargs: Any):
    """Return a connection context manager from a pool, falling back to psycopg.connect."""
    if pool is not None:
        return pool.connection()
    import psycopg

    return psycopg.connect(dsn, **kwargs)
