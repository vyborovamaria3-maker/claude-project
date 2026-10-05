"""merge legacy registry-admin and crawler-control migration heads"""

from __future__ import annotations

revision = "0020_merge_twitter_admin_heads"
down_revision = (
    "0019_twitter_settings_checks",
    "0014_twitter_discovery_admin",
)
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
