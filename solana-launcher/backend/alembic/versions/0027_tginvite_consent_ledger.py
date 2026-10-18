"""Create server-owned, consent-gated TGInvite audit and job ledger.

Direct invitations are intentionally NOT enabled by this migration.

Revision ID: 0027_tginvite_consent_ledger
Revises: 0026_tginvite_session_generation
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0027_tginvite_consent_ledger"
down_revision = "0026_tginvite_session_generation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "telegram_invite_consents",
        sa.Column("id", sa.Uuid(as_uuid=False), primary_key=True),
        sa.Column(
            "owner_id", sa.Uuid(as_uuid=False),
            sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("destination_chat_id", sa.String(128), nullable=False),
        sa.Column("recipient_digest", sa.String(64), nullable=False),
        sa.Column("proof_kind", sa.String(32), nullable=False),
        sa.Column("proof_digest", sa.String(64), nullable=False),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "proof_kind IN ('telegram_bot_start', 'telegram_chat_join_request')",
            name="ck_tginvite_consent_proof_kind",
        ),
        sa.UniqueConstraint("proof_digest", name="uq_tginvite_consent_proof_digest"),
    )
    op.create_index(
        "ix_telegram_invite_consents_owner_id", "telegram_invite_consents", ["owner_id"]
    )

    op.create_table(
        "telegram_invite_jobs",
        sa.Column("id", sa.Uuid(as_uuid=False), primary_key=True),
        sa.Column(
            "owner_id", sa.Uuid(as_uuid=False),
            sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column(
            "consent_id", sa.Uuid(as_uuid=False),
            sa.ForeignKey("telegram_invite_consents.id", ondelete="RESTRICT"), nullable=False,
        ),
        sa.Column("destination_chat_id", sa.String(128), nullable=False),
        sa.Column("idempotency_key", sa.String(96), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="blocked_transport"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            nullable=False, server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "status IN ('blocked_transport', 'cancelled')",
            name="ck_tginvite_job_status_no_dispatch",
        ),
        sa.UniqueConstraint(
            "owner_id", "idempotency_key", name="uq_tginvite_job_owner_request",
        ),
    )
    op.create_index("ix_telegram_invite_jobs_owner_id", "telegram_invite_jobs", ["owner_id"])


def downgrade() -> None:
    op.drop_index("ix_telegram_invite_jobs_owner_id", table_name="telegram_invite_jobs")
    op.drop_table("telegram_invite_jobs")
    op.drop_index("ix_telegram_invite_consents_owner_id", table_name="telegram_invite_consents")
    op.drop_table("telegram_invite_consents")
