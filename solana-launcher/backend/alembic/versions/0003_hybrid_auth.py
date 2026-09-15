"""hybrid auth schema"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from alembic import op
import sqlalchemy as sa


revision = "0003_hybrid_auth"
down_revision = "0002_analytics"
branch_labels = None
depends_on = None


def _user_columns() -> list[sa.Column]:
    return [
        sa.Column("id", sa.Uuid(as_uuid=False), primary_key=True, nullable=False),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("full_name", sa.String(length=255), nullable=True),
        sa.Column("hashed_password", sa.String(length=255), nullable=True),
        sa.Column("wallet_address", sa.String(length=64), nullable=True),
        sa.Column("telegram_id", sa.String(length=64), nullable=True),
        sa.Column("telegram_username", sa.String(length=255), nullable=True),
        sa.Column("first_name", sa.String(length=255), nullable=True),
        sa.Column("last_name", sa.String(length=255), nullable=True),
        sa.Column("photo_url", sa.Text(), nullable=True),
        sa.Column("nonce", sa.Integer(), nullable=True),
        sa.Column("nonce_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_ip", sa.String(length=45), nullable=True),
        sa.Column("ip_addresses", sa.JSON(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("is_superuser", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    ]


def _create_users_new_table() -> sa.Table:
    metadata = sa.MetaData()
    return sa.Table(
        "users_new",
        metadata,
        *[column.copy() for column in _user_columns()],
        sa.UniqueConstraint("email", name="uq_users_email"),
        sa.UniqueConstraint("wallet_address", name="uq_users_wallet_address"),
        sa.UniqueConstraint("telegram_id", name="uq_users_telegram_id"),
    )


def _copy_users_into_new_schema(bind: sa.Connection, users_new: sa.Table) -> None:
    rows = bind.execute(
        sa.text(
            "SELECT id, email, full_name, hashed_password, is_active, is_superuser, created_at "
            "FROM users ORDER BY id"
        )
    ).mappings().all()
    if not rows:
        return

    now = datetime.now(timezone.utc)
    payloads: list[dict[str, object]] = []
    for row in rows:
        created_at = row["created_at"] or now
        payloads.append(
            {
                "id": str(uuid4()),
                "email": row["email"],
                "full_name": row["full_name"],
                "hashed_password": row["hashed_password"],
                "wallet_address": None,
                "telegram_id": None,
                "telegram_username": None,
                "first_name": None,
                "last_name": None,
                "photo_url": None,
                "nonce": None,
                "nonce_expires_at": None,
                "last_login_at": None,
                "last_ip": None,
                "ip_addresses": None,
                "is_active": bool(row["is_active"]),
                "is_superuser": bool(row["is_superuser"]),
                "created_at": created_at,
                "updated_at": created_at,
            }
        )

    bind.execute(users_new.insert(), payloads)


def _create_auth_logs_table() -> None:
    op.create_table(
        "auth_logs",
        sa.Column("id", sa.Uuid(as_uuid=False), primary_key=True, nullable=False),
        sa.Column(
            "user_id",
            sa.Uuid(as_uuid=False),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("success", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("wallet_address", sa.String(length=64), nullable=True),
        sa.Column("telegram_id", sa.String(length=64), nullable=True),
        sa.Column("ip_address", sa.String(length=45), nullable=True),
        sa.Column("user_agent", sa.String(length=512), nullable=True),
        sa.Column("meta", sa.JSON(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index(op.f("ix_auth_logs_id"), "auth_logs", ["id"], unique=False)
    op.create_index(op.f("ix_auth_logs_user_id"), "auth_logs", ["user_id"], unique=False)
    op.create_index(op.f("ix_auth_logs_event_type"), "auth_logs", ["event_type"], unique=False)
    op.create_index(op.f("ix_auth_logs_provider"), "auth_logs", ["provider"], unique=False)
    op.create_index(op.f("ix_auth_logs_wallet_address"), "auth_logs", ["wallet_address"], unique=False)
    op.create_index(op.f("ix_auth_logs_telegram_id"), "auth_logs", ["telegram_id"], unique=False)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table("users"):
        users_new = _create_users_new_table()
        users_new.create(bind)
        _copy_users_into_new_schema(bind, users_new)
        op.drop_table("users")
        op.rename_table("users_new", "users")
    else:
        op.create_table(
            "users",
            *_user_columns(),
            sa.UniqueConstraint("email", name="uq_users_email"),
            sa.UniqueConstraint("wallet_address", name="uq_users_wallet_address"),
            sa.UniqueConstraint("telegram_id", name="uq_users_telegram_id"),
        )

    op.create_index(op.f("ix_users_email"), "users", ["email"], unique=True)
    op.create_index(op.f("ix_users_wallet_address"), "users", ["wallet_address"], unique=True)
    op.create_index(op.f("ix_users_telegram_id"), "users", ["telegram_id"], unique=True)
    op.create_index(op.f("ix_users_nonce"), "users", ["nonce"], unique=False)

    _create_auth_logs_table()


def downgrade() -> None:
    op.drop_index(op.f("ix_auth_logs_telegram_id"), table_name="auth_logs")
    op.drop_index(op.f("ix_auth_logs_wallet_address"), table_name="auth_logs")
    op.drop_index(op.f("ix_auth_logs_provider"), table_name="auth_logs")
    op.drop_index(op.f("ix_auth_logs_event_type"), table_name="auth_logs")
    op.drop_index(op.f("ix_auth_logs_user_id"), table_name="auth_logs")
    op.drop_index(op.f("ix_auth_logs_id"), table_name="auth_logs")
    op.drop_table("auth_logs")

    bind = op.get_bind()
    users_rows = bind.execute(
        sa.text(
            "SELECT email, full_name, hashed_password, is_active, is_superuser, created_at "
            "FROM users ORDER BY created_at ASC"
        )
    ).mappings().all()

    op.create_table(
        "users_old",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("full_name", sa.String(length=255), nullable=True),
        sa.Column("hashed_password", sa.String(length=255), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("is_superuser", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    if users_rows:
        payloads = []
        for index, row in enumerate(users_rows, start=1):
            payloads.append(
                {
                    "id": index,
                    "email": row["email"],
                    "full_name": row["full_name"],
                    "hashed_password": row["hashed_password"],
                    "is_active": bool(row["is_active"]),
                    "is_superuser": bool(row["is_superuser"]),
                    "created_at": row["created_at"],
                }
            )
        users_old_table = sa.table(
            "users_old",
            sa.column("id", sa.Integer()),
            sa.column("email", sa.String()),
            sa.column("full_name", sa.String()),
            sa.column("hashed_password", sa.String()),
            sa.column("is_active", sa.Boolean()),
            sa.column("is_superuser", sa.Boolean()),
            sa.column("created_at", sa.DateTime(timezone=True)),
        )
        op.bulk_insert(users_old_table, payloads)

    op.drop_index(op.f("ix_users_nonce"), table_name="users")
    op.drop_index(op.f("ix_users_telegram_id"), table_name="users")
    op.drop_index(op.f("ix_users_wallet_address"), table_name="users")
    op.drop_index(op.f("ix_users_email"), table_name="users")
    op.drop_table("users")
    op.rename_table("users_old", "users")
    op.create_index(op.f("ix_users_id"), "users", ["id"], unique=False)
