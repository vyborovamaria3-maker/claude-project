"""Add one-time, consent-gated direct-invite job outcomes.

Revision ID: 0028_tginvite_direct_invite
Revises: 0027_tginvite_consent_ledger
"""

import sqlalchemy as sa
from alembic import op

revision = "0028_tginvite_direct_invite"
down_revision = "0027_tginvite_consent_ledger"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Legacy blocked audit jobs keep NULL; only direct jobs get an HMAC digest.
    op.add_column("telegram_invite_jobs", sa.Column(
        "direct_recipient_digest", sa.String(64), nullable=True,
    ))
    op.create_unique_constraint(
        "uq_tginvite_direct_once_per_recipient",
        "telegram_invite_jobs",
        ["owner_id", "destination_chat_id", "direct_recipient_digest"],
    )
    op.drop_constraint(
        "ck_tginvite_job_status_no_dispatch", "telegram_invite_jobs", type_="check",
    )
    op.create_check_constraint(
        "ck_tginvite_job_status_no_dispatch", "telegram_invite_jobs",
        "status IN ('blocked_transport', 'cancelled', 'reserved', 'invited', 'declined', 'unknown')",
    )
    op.create_check_constraint(
        "ck_tginvite_direct_requires_digest", "telegram_invite_jobs",
        "(status NOT IN ('reserved', 'invited', 'declined', 'unknown')) "
        "OR direct_recipient_digest IS NOT NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_tginvite_direct_requires_digest", "telegram_invite_jobs", type_="check",
    )
    op.drop_constraint(
        "ck_tginvite_job_status_no_dispatch", "telegram_invite_jobs", type_="check",
    )
    op.create_check_constraint(
        "ck_tginvite_job_status_no_dispatch", "telegram_invite_jobs",
        "status IN ('blocked_transport', 'cancelled')",
    )
    op.drop_constraint(
        "uq_tginvite_direct_once_per_recipient", "telegram_invite_jobs", type_="unique",
    )
    op.drop_column("telegram_invite_jobs", "direct_recipient_digest")
