from __future__ import annotations

from datetime import datetime
from typing import Any

import psycopg
from psycopg.rows import dict_row

from .database import DataSource, SourceRegistry

TWITTER_MONITOR_TABLES = (
    "twitter_crawler_runs",
    "twitter_crawler_settings",
    "twitter_discovery_candidates",
    "twitter_discovery_evidence",
    "twitter_discovery_scores",
    "twitter_accounts",
    "twitter_account_snapshots",
    "twitter_account_scores",
    "twitter_posts",
    "twitter_post_tokens",
    "twitter_account_token_stats",
)

TWITTER_SETTINGS_FIELDS = (
    "enabled",
    "query_limit",
    "process_limit",
    "batch_size",
    "max_depth",
    "min_relevance",
    "network_mode",
    "network_limit",
    "lease_seconds",
    "rescore_limit",
    "public_enabled",
    "public_dexscreener_latest",
    "public_dexscreener_boosts",
    "public_db_solana_tokens",
    "public_cmc_limit",
    "public_rescore_limit",
)


def find_twitter_source(registry: SourceRegistry) -> DataSource:
    try:
        source = registry.get("potapoff")
        if source.config.kind == "postgres":
            return source
    except ValueError:
        pass

    for source in registry.all():
        if source.config.kind == "postgres" and source.config.role == "core":
            return source
    raise RuntimeError("POTAPoff PostgreSQL source is not configured")


class TwitterMonitoringStore:
    def __init__(self, source: DataSource) -> None:
        if source.config.kind != "postgres":
            raise ValueError("Twitter monitoring requires a PostgreSQL source")
        self.source = source
        self.dsn = source.config.dsn

    def _connect(self):
        return psycopg.connect(
            self.dsn,
            autocommit=False,
            connect_timeout=5,
            row_factory=dict_row,
        )

    def snapshot(self) -> dict[str, Any]:
        with self._connect() as db:
            with db.transaction():
                db.execute("SET TRANSACTION READ ONLY")
                db.execute("SET LOCAL statement_timeout=5000")
                existing = {
                    str(row["table_name"])
                    for row in db.execute(
                        """
                        SELECT table_name
                        FROM information_schema.tables
                        WHERE table_schema = 'public' AND table_name = ANY(%s)
                        """,
                        (list(TWITTER_MONITOR_TABLES),),
                    ).fetchall()
                }
                required = {"twitter_crawler_settings", "twitter_crawler_runs"}
                if not required.issubset(existing):
                    missing = ", ".join(sorted(required - existing))
                    raise RuntimeError(f"Twitter monitoring migrations are not applied: {missing}")

                settings = db.execute(
                    "SELECT * FROM twitter_crawler_settings WHERE id = 1"
                ).fetchone()
                if settings is None:
                    raise RuntimeError("Twitter crawler settings row is missing")

                metrics = db.execute(
                    """
                    SELECT
                      (SELECT COUNT(*) FROM twitter_accounts) AS accounts_total,
                      (SELECT COUNT(*) FROM twitter_accounts WHERE first_seen_at >= NOW() - INTERVAL '24 hours') AS accounts_24h,
                      (SELECT COUNT(*) FROM twitter_discovery_candidates) AS candidates_total,
                      (SELECT COUNT(*) FROM twitter_discovery_candidates WHERE first_seen_at >= NOW() - INTERVAL '24 hours') AS candidates_24h,
                      (SELECT COUNT(*) FROM twitter_posts) AS posts_total,
                      (SELECT COUNT(*) FROM twitter_posts WHERE published_at >= NOW() - INTERVAL '24 hours') AS posts_24h,
                      (SELECT COUNT(*) FROM twitter_crawler_runs WHERE status = 'running' AND heartbeat_at >= NOW() - INTERVAL '2 hours') AS running_runs,
                      (SELECT COUNT(*) FROM twitter_crawler_runs WHERE status = 'running' AND heartbeat_at < NOW() - INTERVAL '2 hours') AS stale_running_runs,
                      (SELECT COUNT(*) FROM twitter_crawler_runs WHERE status = 'failed' AND started_at >= NOW() - INTERVAL '24 hours') AS failed_runs_24h,
                      (SELECT COUNT(*) FROM twitter_crawler_runs WHERE status = 'degraded' AND started_at >= NOW() - INTERVAL '24 hours') AS degraded_runs_24h
                    """
                ).fetchone()

                candidate_statuses = db.execute(
                    """
                    SELECT status, COUNT(*) AS count
                    FROM twitter_discovery_candidates
                    GROUP BY status
                    ORDER BY count DESC, status ASC
                    """
                ).fetchall()
                recent_runs = db.execute(
                    """
                    SELECT id, job_name, status, phase, worker, started_at, heartbeat_at,
                           finished_at, duration_ms, error, summary,
                           (status = 'running' AND heartbeat_at < NOW() - INTERVAL '2 hours') AS stale
                    FROM twitter_crawler_runs
                    ORDER BY started_at DESC, id DESC
                    LIMIT 30
                    """
                ).fetchall()
                recent_accounts = db.execute(
                    """
                    SELECT id, twitter_id, username, display_name, account_type, status,
                           followers_count, following_count, tweet_count, verified, source,
                           first_seen_at, last_seen_at, last_profile_sync_at
                    FROM twitter_accounts
                    ORDER BY first_seen_at DESC, id DESC
                    LIMIT 50
                    """
                ).fetchall()

        return {
            "source_id": self.source.config.id,
            "source_label": self.source.config.label,
            "settings": dict(settings),
            "metrics": dict(metrics or {}),
            "candidate_statuses": [dict(row) for row in candidate_statuses],
            "recent_runs": [dict(row) for row in recent_runs],
            "recent_accounts": [dict(row) for row in recent_accounts],
            "tables": [table for table in TWITTER_MONITOR_TABLES if table in existing],
        }

    def update_settings(
        self,
        values: dict[str, Any],
        *,
        expected_updated_at: datetime,
    ) -> dict[str, Any] | None:
        unknown = set(values) - set(TWITTER_SETTINGS_FIELDS)
        if unknown:
            raise ValueError(f"Unsupported Twitter setting(s): {', '.join(sorted(unknown))}")
        if set(values) != set(TWITTER_SETTINGS_FIELDS):
            missing = set(TWITTER_SETTINGS_FIELDS) - set(values)
            raise ValueError(f"Missing Twitter setting(s): {', '.join(sorted(missing))}")

        assignments = ", ".join(f'"{field}" = %s' for field in TWITTER_SETTINGS_FIELDS)
        params = [values[field] for field in TWITTER_SETTINGS_FIELDS]
        params.extend([expected_updated_at])
        sql = f"""
            UPDATE twitter_crawler_settings
            SET {assignments}, updated_at = NOW()
            WHERE id = 1 AND updated_at = %s
            RETURNING *
        """

        with self._connect() as db:
            db.execute("SET LOCAL statement_timeout=5000")
            db.execute("SET LOCAL lock_timeout=2000")
            row = db.execute(sql, params).fetchone()
            if row is None:
                db.rollback()
                return None
            db.commit()
            return dict(row)
