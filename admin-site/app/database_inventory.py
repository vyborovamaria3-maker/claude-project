from __future__ import annotations

from collections import defaultdict
from typing import Any

from .database import SourceRegistry

ENTITY_TABLE_HINTS: dict[str, tuple[str, ...]] = {
    "wallets": ("wallets", "dev_wallets", "wallet_stats", "wallet_token_stats"),
    "coins": ("tokens", "dev_tokens", "analyzed_mints", "token_metrics"),
    "twitter_accounts": ("twitter_accounts", "social_accounts"),
    "twitter_posts": ("tweets", "twitter_token_tweets", "x_mentions", "twitter_mentions", "social_posts"),
    "telegram_accounts": ("telegram_users",),
    "telegram_channels": ("telegram_channels",),
    "telegram_messages": ("telegram_messages", "telegram_posts"),
    "users": ("users", "user", "app_users", "clients"),
    "trades": ("wallet_trades", "token_trades"),
    "payments": ("payments", "paymenttransaction"),
    "signals": ("telegram_calls", "market_events", "telegram_ai_results", "telegram_analysis_results"),
}


def _entity_buckets(table_name: str) -> set[str]:
    normalized = table_name.strip().lower()
    output: set[str] = set()
    for bucket, hints in ENTITY_TABLE_HINTS.items():
        if normalized in {value.lower() for value in hints}:
            output.add(bucket)
    return output


def build_database_inventory(registry: SourceRegistry) -> dict[str, Any]:
    sources: list[dict[str, Any]] = []
    entity_counts: dict[str, int] = defaultdict(int)
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

        for table_name in table_names:
            try:
                columns = source.columns(table_name)
                row_count = source.estimate_count(table_name)
            except Exception:
                item["tables"].append({"name": table_name, "ok": False, "error": "table_unavailable"})
                continue

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
            for bucket in _entity_buckets(table_name):
                entity_counts[bucket] += row_count

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
        "count_semantics": "fast_estimate",
    }
