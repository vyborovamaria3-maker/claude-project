from __future__ import annotations

from pathlib import Path
from typing import Any

from .config import LogConfig
from .database import DataSource, SourceRegistry

USER_TABLES = {"user", "users", "app_users", "telegram_users", "clients"}
BLOCKCHAIN_TABLES = [
    "tokens", "token_metrics", "wallets", "wallet_trades", "analyzed_mints", "token_trades",
    "wallet_stats", "wallet_token_stats", "dev_wallets", "dev_tokens", "market_events",
    "migration_token_rows", "migration_wallet_rows", "payments", "PaymentTransaction",
]
X_TABLES = [
    "twitter_crawler_runs", "twitter_crawler_settings", "twitter_discovery_candidates",
    "twitter_discovery_evidence", "twitter_discovery_scores", "twitter_accounts",
    "twitter_account_snapshots", "twitter_account_scores", "twitter_posts",
    "twitter_post_tokens", "twitter_account_token_stats", "twitter_token_analyses",
    "twitter_token_tweets", "twitter_token_shillers", "twitter_social_discoveries",
    "x_mentions", "twitter_mentions", "tweets", "x_search_runs", "social_posts",
    "social_accounts",
]
TELEGRAM_TABLES = [
    "NotificationLog", "notification_logs", "notifications", "agents", "tasks",
    "telegram_channels", "telegram_messages", "telegram_posts", "telegram_entities",
    "telegram_message_entities", "telegram_ai_runs", "telegram_ai_results",
    "telegram_ai_cache", "telegram_analysis_runs", "telegram_analysis_results",
]


def source_summary(registry: SourceRegistry) -> list[dict[str, Any]]:
    output = []
    for source in registry.all():
        health = source.health()
        tables: list[str] = []
        row_total = 0
        errors: list[str] = []
        if health["ok"]:
            try:
                tables = source.tables()
                for table in tables:
                    try:
                        row_total += source.estimate_count(table)
                    except Exception as exc:
                        errors.append(f"{table}: {str(exc)[:120]}")
            except Exception as exc:
                errors.append(str(exc)[:300])
        output.append(
            {
                "id": source.config.id,
                "label": source.config.label,
                "kind": source.config.kind,
                "role": source.config.role,
                "ok": health["ok"],
                "error": health["error"],
                "tables": len(tables),
                "rows": row_total,
                "warnings": errors[:5],
            }
        )
    return output


def combined_users(registry: SourceRegistry, limit_per_source: int = 250) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for source in registry.all():
        try:
            tables = source.tables()
        except Exception:
            continue
        for table in tables:
            if table.lower() not in USER_TABLES:
                continue
            try:
                rows = source.recent(table, limit=limit_per_source)
            except Exception:
                continue
            for row in rows:
                result.append(_normalize_user(source, table, row))
    result.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    return result


def _first(row: dict[str, Any], names: tuple[str, ...]) -> Any:
    for name in names:
        if name in row and row[name] not in (None, ""):
            return row[name]
    return None


def _normalize_user(source: DataSource, table: str, row: dict[str, Any]) -> dict[str, Any]:
    return {
        "source": source.config.label,
        "source_id": source.config.id,
        "table": table,
        "id": _first(row, ("id", "user_id", "telegramId", "telegram_id")),
        "login": _first(row, ("email", "login", "username", "telegramUsername", "telegram_username")),
        "name": _first(row, ("full_name", "firstName", "first_name", "name")),
        "telegram_id": _first(row, ("telegramId", "telegram_id")),
        "telegram_username": _first(row, ("telegramUsername", "telegram_username", "username")),
        "wallet": _first(row, ("wallet_address", "walletAddress", "publicKey", "public_key")),
        "created_at": _first(row, ("createdAt", "created_at")),
        "last_login_at": _first(row, ("lastLoginAt", "last_login_at")),
        "subscription_expires_at": _first(row, ("subscriptionEnd", "subscription_expires_at", "endsAt")),
        "active": _first(row, ("isActive", "is_active", "status")),
        "raw": row,
    }


def domain_tables(registry: SourceRegistry, candidates: list[str], *, limit: int = 100) -> dict[str, Any]:
    sections: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    candidate_set = {value.lower() for value in candidates}
    for source in registry.all():
        try:
            tables = source.tables()
        except Exception:
            continue
        for table in tables:
            if table.lower() not in candidate_set:
                continue
            try:
                count = source.count(table)
                rows = source.recent(table, limit=limit)
                counts[f"{source.config.id}.{table}"] = count
                sections.append(
                    {"source": source.config.id, "source_label": source.config.label, "table": table, "count": count, "rows": rows}
                )
            except Exception as exc:
                sections.append(
                    {"source": source.config.id, "source_label": source.config.label, "table": table, "count": 0, "rows": [], "error": str(exc)}
                )
    return {"counts": counts, "sections": sections}


def log_catalog(logs: list[LogConfig]) -> list[dict[str, Any]]:
    output = []
    for item in logs:
        path = Path(item.path)
        output.append(
            {
                "id": item.id,
                "label": item.label,
                "path": item.path,
                "exists": path.exists() and path.is_file(),
                "size": path.stat().st_size if path.exists() and path.is_file() else 0,
            }
        )
    return output


def read_log(log: LogConfig, *, lines: int = 300, search: str = "") -> dict[str, Any]:
    path = Path(log.path)
    if not path.exists() or not path.is_file():
        return {"id": log.id, "label": log.label, "lines": [], "error": "Log file is not mounted"}
    lines = max(1, min(lines, 5000))
    with path.open("rb") as stream:
        stream.seek(0, 2)
        position = stream.tell()
        block = 8192
        chunks: list[bytes] = []
        newline_count = 0
        while position > 0 and newline_count <= lines * 3:
            size = min(block, position)
            position -= size
            stream.seek(position)
            chunk = stream.read(size)
            chunks.append(chunk)
            newline_count += chunk.count(b"\n")
        text = b"".join(reversed(chunks)).decode("utf-8", errors="replace")
    values = text.splitlines()
    if search.strip():
        needle = search.strip().lower()
        values = [value for value in values if needle in value.lower()]
    return {"id": log.id, "label": log.label, "lines": values[-lines:], "error": None}


def global_search(registry: SourceRegistry, query: str, *, limit_per_table: int = 20, max_tables: int = 80) -> dict[str, Any]:
    needle = query.strip()
    if not needle:
        return {"query": query, "results": [], "scanned_tables": 0}
    results: list[dict[str, Any]] = []
    scanned = 0
    for source in registry.all():
        try:
            tables = source.tables()
        except Exception:
            continue
        for table in tables:
            if scanned >= max_tables:
                break
            scanned += 1
            try:
                page = source.rows(table, page=1, page_size=limit_per_table, search=needle)
            except Exception:
                continue
            for row in page.get("rows", []):
                results.append({"source": source.config.id, "source_label": source.config.label, "table": table, "row": row})
                if len(results) >= 200:
                    return {"query": needle, "results": results, "scanned_tables": scanned, "truncated": True}
    return {"query": needle, "results": results, "scanned_tables": scanned, "truncated": False}


def relation_graph(registry: SourceRegistry, query: str, *, limit: int = 100) -> dict[str, Any]:
    search = global_search(registry, query, limit_per_table=10, max_tables=100)
    nodes: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, str]] = []
    root_id = f"query:{query}"
    nodes[root_id] = {"id": root_id, "label": query, "type": "query"}
    for index, item in enumerate(search["results"][:limit]):
        table_id = f"table:{item['source']}:{item['table']}"
        nodes.setdefault(table_id, {"id": table_id, "label": item["table"], "type": "table", "source": item["source_label"]})
        edges.append({"source": root_id, "target": table_id, "type": "found_in"})
        row = item["row"]
        row_id = f"row:{index}"
        label = next((str(row.get(k)) for k in ("symbol", "name", "username", "address", "wallet", "id") if row.get(k) not in (None, "")), f"row {index+1}")
        nodes[row_id] = {"id": row_id, "label": label[:80], "type": "record", "data": row}
        edges.append({"source": table_id, "target": row_id, "type": "contains"})
    return {"query": query, "nodes": list(nodes.values()), "edges": edges, "truncated": search.get("truncated", False)}


def queue_overview(registry: SourceRegistry, limit: int = 100) -> dict[str, Any]:
    candidates = [
        "jobs",
        "tasks",
        "queue_jobs",
        "analysis_runs",
        "telegram_ai_runs",
        "x_search_runs",
        "twitter_discovery_candidates",
        "twitter_crawler_runs",
    ]
    return domain_tables(registry, candidates, limit=limit)
