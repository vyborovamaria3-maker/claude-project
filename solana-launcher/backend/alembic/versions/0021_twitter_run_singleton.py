"""enforce one active Twitter crawler run per job"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0021_twitter_run_singleton"
down_revision = "0020_merge_twitter_admin_heads"
branch_labels = None
depends_on = None


INDEX_NAME = "uq_twitter_crawler_runs_running_job"


def upgrade() -> None:
    # Existing duplicate running rows would make the unique index fail. Preserve
    # the newest run and close older rows deterministically before adding the
    # invariant. The normal runtime also expires stale rows, but this migration
    # must be safe against pre-existing concurrent rows of any age.
    op.execute(
        sa.text(
            """
            WITH ranked AS (
                SELECT id,
                       ROW_NUMBER() OVER (
                           PARTITION BY job_name
                           ORDER BY heartbeat_at DESC, started_at DESC, id DESC
                       ) AS row_number
                FROM twitter_crawler_runs
                WHERE status = 'running'
            )
            UPDATE twitter_crawler_runs AS runs
            SET status = 'failed',
                phase = 'superseded_before_singleton_index',
                finished_at = COALESCE(runs.finished_at, CURRENT_TIMESTAMP),
                duration_ms = COALESCE(
                    runs.duration_ms,
                    GREATEST(
                        0,
                        CAST(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - runs.started_at)) * 1000 AS BIGINT)
                    )
                ),
                error = COALESCE(runs.error, 'superseded while enforcing active-run singleton')
            FROM ranked
            WHERE runs.id = ranked.id
              AND ranked.row_number > 1
            """
        )
    )
    op.create_index(
        INDEX_NAME,
        "twitter_crawler_runs",
        ["job_name"],
        unique=True,
        postgresql_where=sa.text("status = 'running'"),
    )


def downgrade() -> None:
    op.drop_index(INDEX_NAME, table_name="twitter_crawler_runs")
