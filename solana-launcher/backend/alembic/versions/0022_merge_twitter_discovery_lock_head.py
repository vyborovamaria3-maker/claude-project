"""merge the restored discovery lock migration into the canonical head"""

from __future__ import annotations

revision = "0022_merge_twitter_discovery_lock_head"
down_revision = (
    "0021_twitter_run_singleton",
    "0015_twitter_discovery_run_lock",
)
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
