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
            table_names = source.tables()
        except Exception:
            item["ok"] = False
            item["error"] = "source_unavailable"
            sources.append(item)
            continue

        row_counts_by_table: dict[str, int] = {}
        for table_name in table_names:
            try:
                columns = source.columns(table_name)
                row_count = source.estimate_count(table_name)
            except Exception:
                item["tables"].append({"name": table_name, "ok": False, "error": "table_unavailable"})
                continue

            row_counts_by_table[table_name.lower()] = row_count
            column_payload = [
                {
                    "name": column.name,
                    "type": column.type,
                    "nullable": column.nullable,
                    "primary_key": column.primary_key,
                }
                for column in columns
            ]
            item["tables"].append({
                "name": table_name,
                "ok": True,
                "rows": row_count,
                "columns": column_payload,
                "column_count": len(column_payload),
            })
            item["table_count"] += 1
            item["column_count"] += len(column_payload)
            item["row_count"] += row_count
            total_tables += 1
            total_columns += len(column_payload)
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
    }
