"""add access password hash for miniapp dual-secret auth"""

from alembic import op
import sqlalchemy as sa


revision = "0004_access_password_hash"
down_revision = "0003_hybrid_auth"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("access_password_hash", sa.String(length=255), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "access_password_hash")
