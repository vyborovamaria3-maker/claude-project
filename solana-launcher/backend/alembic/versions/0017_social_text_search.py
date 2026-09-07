"""add PostgreSQL FTS and trigram indexes for social evidence"""

from __future__ import annotations

from alembic import op

revision = "0017_social_text_search"
down_revision = "0016_campaign_similarity_projection"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    # Production uses migration-first rollout while the previous application can
    # still be serving and ingesting social events. PostgreSQL cannot run a
    # concurrent index build inside a transaction, so use Alembic's autocommit
    # block and avoid a long write-blocking GIN build on social_events.
    with op.get_context().autocommit_block():
        op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        op.execute(
            """
            CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_social_events_text_fts
            ON social_events
            USING GIN (to_tsvector('simple', coalesce(text, '')))
            """
        )
        op.execute(
            """
            CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_social_events_text_trgm
            ON social_events
            USING GIN (lower(text) gin_trgm_ops)
            WHERE text IS NOT NULL
            """
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    with op.get_context().autocommit_block():
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS ix_social_events_text_trgm")
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS ix_social_events_text_fts")
    # Do not drop pg_trgm: another application/index may also use the extension.
