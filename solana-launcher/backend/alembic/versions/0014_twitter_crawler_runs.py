"""add Twitter crawler run audit log"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0014_twitter_crawler_runs"
down_revision = "0013_twitter_discovery_scoring"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "twitter_crawler_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("job_name", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False, server_default="running"),
        sa.Column("phase", sa.String(length=64), nullable=False, server_default="starting"),
        sa.Column("worker", sa.String(length=160), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_ms", sa.BigInteger(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("summary", sa.JSON(), nullable=True),
        sa.Column("meta", sa.JSON(), nullable=True),
    )
    op.create_index(
        "ix_twitter_crawler_runs_job_started",
        "twitter_crawler_runs",
        ["job_name", "started_at"],
    )
    op.create_index(
        "ix_twitter_crawler_runs_status_heartbeat",
        "twitter_crawler_runs",
        ["status", "heartbeat_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_twitter_crawler_runs_status_heartbeat",
        table_name="twitter_crawler_runs",
    )
    op.drop_index(
        "ix_twitter_crawler_runs_job_started",
        table_name="twitter_crawler_runs",
    )
    op.drop_table("twitter_crawler_runs")
