from __future__ import annotations

from collections import defaultdict
from typing import Any

from .database import SourceRegistry

# Ordered canonical-table fallbacks. Only the first available table per source is
# counted for an entity, so denormalized/statistics tables do not inflate totals.
ENTITY_TABLE_PRIORITY: dict[str, tuple[str, ...]] = {
    "wallets": ("wallets", "dev_wallets", "wallet_stats", "wallet_token_stats"),
    "coins": ("tokens", "analyzed_mints", "dev_tokens", "token_metrics"),
    "twitter_accounts": ("twitter_accounts", "social_accounts"),
    "twitter_posts": ("tweets", "twitter_token_tweets", "social_posts", "x_mentions", "twitter_mentions"),
    "telegram_accounts": ("telegram_users",),
    "telegram_channels": ("telegram_channels",),
    "telegram_messages": ("telegram_messages", "telegram_posts"),
    "users": ("users", "user", "app_users", "clients"),
    "trades": ("wallet_trades", "token_trades"),
    "payments": ("payments", "paymenttransaction"),
    "signals": ("telegram_calls", "market_events", "telegram_ai_results", "telegram_analysis_results"),
}


def _postgres_inventory(source: Any) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Fetch an entire PostgreSQL schema in two round-trips, regardless of table count."""
    with source.connect() as db:
        column_rows = db.execute(
            """
            SELECT c.table_name, c.column_name, c.data_type, c.is_nullable,
                   EXISTS (
                     SELECT 1
                     FROM information_schema.table_constraints tc
                     JOIN information_schema.key_column_usage kcu
                       ON tc.constraint_name=kcu.constraint_name
                      AND tc.table_schema=kcu.table_schema
                      AND tc.table_name=kcu.table_name
                     WHERE tc.constraint_type='PRIMARY KEY'
                       AND tc.table_schema=c.table_schema
                       AND tc.table_name=c.table_name
                       AND kcu.column_name=c.column_name
                   ) AS primary_key
            FROM information_schema.columns c
            JOIN information_schema.tables t
              ON t.table_schema=c.table_schema
             AND t.table_name=c.table_name
             AND t.table_type='BASE TABLE'
            WHERE c.table_schema=%s
            ORDER BY c.table_name, c.ordinal_position
            """,
            (source.config.schema,),
        ).fetchall()
        count_rows = db.execute(
            """
            SELECT relname AS table_name, COALESCE(n_live_tup, 0)::bigint AS row_count
            FROM pg_stat_user_tables
            WHERE schemaname=%s
            """,
            (source.config.schema,),
        ).fetchall()

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in column_rows:
        grouped[str(row["table_name"])].append({
            "name": str(row["column_name"]),
            "type": str(row["data_type"]),
            "nullable": row["is_nullable"] == "YES",
            "primary_key": bool(row["primary_key"]),
        })
    counts = {str(row["table_name"]).lower(): int(row["row_count"] or 0) for row in count_rows}
    tables = [
        {
            "name": table_name,
            "ok": True,
            "rows": counts.get(table_name.lower(), 0),
            "columns": columns,
            "column_count": len(columns),
        }
        for table_name, columns in grouped.items()
    ]
    return tables, counts


def _generic_inventory(source: Any) -> tuple[list[dict[str, Any]], dict[str, int]]:
    tables: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    for table_name in source.tables():
        try:
            columns = source.columns(table_name)
            row_count = source.estimate_count(table_name)
        except Exception:
            tables.append({"name": table_name, "ok": False, "error": "table_unavailable"})
            continue
        counts[table_name.lower()] = row_count
        column_payload = [
            {
                "name": column.name,
                "type": column.type,
                "nullable": column.nullable,
                "primary_key": column.primary_key,
            }
            for column in columns
        ]
        tables.append({
            "name": table_name,
            "ok": True,
            "rows": row_count,
            "columns": column_payload,
            "column_count": len(column_payload),
        })
    return tables, counts


def build_database_inventory(registry: SourceRegistry) -> dict[str, Any]:
    sources: list[dict[str, Any]] = []
    entity_counts: dict[str, int] = defaultdict(int)
    entity_sources: dict[str, list[dict[str, Any]]] = defaultdict(list)
    total_tables = 0
    total_columns = 0
    total_rows = 0

    for source in registry.all():
        item: dict[str, Any] = {
            "id": source.config.id,
            "label": source.config.label,
            "kind": source.config.kind,
            "role": source.config.role,
            "ok": True,
            "tables": [],
            "table_count": 0,
            "column_count": 0,
            "row_count": 0,
        }
        try:
            if source.config.kind == "postgres":
                tables, row_counts_by_table = _postgres_inventory(source)
            else:
                tables, row_counts_by_table = _generic_inventory(source)
        except Exception:
            item["ok"] = False
            item["error"] = "source_unavailable"
            sources.append(item)
            continue

        item["tables"] = tables
        for table in tables:
            if not table.get("ok"):
                continue
            row_count = int(table.get("rows") or 0)
            column_count = int(table.get("column_count") or 0)
            item["table_count"] += 1
            item["column_count"] += column_count
            item["row_count"] += row_count
            total_tables += 1
            total_columns += column_count
            total_rows += row_count

        for entity, priorities in ENTITY_TABLE_PRIORITY.items():
            selected_table = next((name for name in priorities if name.lower() in row_counts_by_table), None)
            if selected_table is None:
                continue
            count = row_counts_by_table[selected_table.lower()]
            entity_counts[entity] += count
            entity_sources[entity].append({
                "source": source.config.id,
                "table": selected_table,
                "count": count,
            })

        sources.append(item)

    return {
        "sources": sources,
        "totals": {
            "sources": len(sources),
            "tables": total_tables,
            "columns": total_columns,
            "rows": total_rows,
        },
        "entities": dict(sorted(entity_counts.items())),
        "entity_sources": {key: value for key, value in sorted(entity_sources.items())},
        "count_semantics": "fast_estimate_canonical_table",
        "postgres_inventory_round_trips_per_source": 2,
    }
