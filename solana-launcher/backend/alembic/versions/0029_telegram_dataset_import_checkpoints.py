"""Persist Telegram dataset import checkpoints."""

from alembic import op
import sqlalchemy as sa

revision = "0029_telegram_dataset_import_checkpoints"
down_revision = "0028_tginvite_direct_invite"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "telegram_dataset_import_checkpoints",
        sa.Column("path_hash", sa.String(length=64), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("file_size", sa.BigInteger(), nullable=False),
        sa.Column("modified_at_ns", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("path_hash"),
    )


def downgrade() -> None:
    op.drop_table("telegram_dataset_import_checkpoints")
