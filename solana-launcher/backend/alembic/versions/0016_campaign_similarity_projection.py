"""add compact campaign similarity projection"""

from __future__ import annotations

import json
import math
from typing import Any

import sqlalchemy as sa
from alembic import op

revision = "0016_campaign_similarity_projection"
down_revision = "0015_hypothesis_endpoint_indexes"
branch_labels = None
depends_on = None

VECTOR_KEYS = (
    "x_accounts",
    "tg_channels",
    "wallets",
    "bundles",
    "shared_links",
    "copies",
    "amplifies",
    "mentions_wallet",
    "social_score",
    "x_score",
    "telegram_score",
    "organic",
    "manipulation",
    "early",
    "alpha",
    "bot_risk",
)


def _finite_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _decode_json(value: Any, fallback: Any) -> Any:
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return fallback


def _backfill_non_postgres(bind) -> None:
    rows = list(
        bind.execute(
            sa.text(
                "SELECT snapshot_id, mint_address, vector, actors, created_at "
                "FROM campaign_fingerprints"
            )
        ).mappings()
    )
    feature_rows: list[dict[str, Any]] = []
    actor_rows: list[dict[str, str]] = []
    for row in rows:
        vector = _decode_json(row["vector"], {})
        if _finite_float(vector.get("schema_v2")) != 1.0:
            continue
        values = {
            key: _finite_float(vector.get(key)) or 0.0
            for key in VECTOR_KEYS
        }
        actor_keys = sorted(
            {
                str(actor).strip()
                for actor in _decode_json(row["actors"], [])
                if str(actor).strip()
            }
        )
        feature_rows.append(
            {
                "snapshot_id": row["snapshot_id"],
                "mint_address": row["mint_address"],
                "created_at": row["created_at"],
                "schema_version": 2,
                **values,
                "vector_norm": math.sqrt(
                    sum(value * value for value in values.values())
                ),
                "actor_count": len(actor_keys),
            }
        )
        actor_rows.extend(
            {
                "snapshot_id": str(row["snapshot_id"]),
                "actor_key": actor_key,
            }
            for actor_key in actor_keys
        )

    if feature_rows:
        columns = (
            "snapshot_id, mint_address, created_at, schema_version, "
            + ", ".join(VECTOR_KEYS)
            + ", vector_norm, actor_count"
        )
        values = (
            ":snapshot_id, :mint_address, :created_at, :schema_version, "
            + ", ".join(f":{key}" for key in VECTOR_KEYS)
            + ", :vector_norm, :actor_count"
        )
        bind.execute(
            sa.text(
                f"INSERT INTO campaign_fingerprint_features ({columns}) "
                f"VALUES ({values})"
            ),
            feature_rows,
        )
    if actor_rows:
        bind.execute(
            sa.text(
                "INSERT INTO campaign_fingerprint_actors "
                "(snapshot_id, actor_key) VALUES (:snapshot_id, :actor_key)"
            ),
            actor_rows,
        )


def upgrade() -> None:
    op.create_table(
        "campaign_fingerprint_features",
        sa.Column(
            "snapshot_id",
            sa.String(length=160),
            sa.ForeignKey("campaign_fingerprints.snapshot_id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("mint_address", sa.String(length=64), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        *[
            sa.Column(key, sa.Float(), nullable=False, server_default="0")
            for key in VECTOR_KEYS
        ],
        sa.Column("vector_norm", sa.Float(), nullable=False, server_default="0"),
        sa.Column("actor_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index(
        "ix_campaign_fingerprint_features_schema_created",
        "campaign_fingerprint_features",
        ["schema_version", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_campaign_fingerprint_features_mint_created",
        "campaign_fingerprint_features",
        ["mint_address", "created_at"],
        unique=False,
    )

    op.create_table(
        "campaign_fingerprint_actors",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "snapshot_id",
            sa.String(length=160),
            sa.ForeignKey(
                "campaign_fingerprint_features.snapshot_id",
                ondelete="CASCADE",
            ),
            nullable=False,
        ),
        sa.Column("actor_key", sa.String(length=160), nullable=False),
        sa.UniqueConstraint(
            "snapshot_id",
            "actor_key",
            name="uq_campaign_fingerprint_actor",
        ),
    )
    op.create_index(
        "ix_campaign_fingerprint_actors_actor_snapshot",
        "campaign_fingerprint_actors",
        ["actor_key", "snapshot_id"],
        unique=False,
    )

    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        _backfill_non_postgres(bind)
        return

    numeric_selects = ",\n                ".join(
        f"COALESCE((fingerprint.vector ->> '{key}')::double precision, 0) AS {key}"
        for key in VECTOR_KEYS
    )
    norm_expression = " + ".join(
        f"prepared.{key} * prepared.{key}"
        for key in VECTOR_KEYS
    )
    op.execute(
        sa.text(
            f"""
            INSERT INTO campaign_fingerprint_features (
                snapshot_id,
                mint_address,
                schema_version,
                created_at,
                {', '.join(VECTOR_KEYS)},
                vector_norm,
                actor_count
            )
            SELECT
                prepared.snapshot_id,
                prepared.mint_address,
                2,
                prepared.created_at,
                {', '.join(f'prepared.{key}' for key in VECTOR_KEYS)},
                sqrt({norm_expression}),
                prepared.actor_count
            FROM (
                SELECT
                    fingerprint.snapshot_id,
                    fingerprint.mint_address,
                    fingerprint.created_at,
                    {numeric_selects},
                    (
                        SELECT count(DISTINCT actor.value)
                        FROM jsonb_array_elements_text(
                            COALESCE(fingerprint.actors::jsonb, '[]'::jsonb)
                        ) AS actor(value)
                        WHERE actor.value <> ''
                    ) AS actor_count
                FROM campaign_fingerprints AS fingerprint
                WHERE COALESCE(
                    (fingerprint.vector ->> 'schema_v2')::double precision,
                    0
                ) = 1.0
            ) AS prepared
            """
        )
    )
    op.execute(
        sa.text(
            """
            INSERT INTO campaign_fingerprint_actors (snapshot_id, actor_key)
            SELECT DISTINCT fingerprint.snapshot_id, actor.value
            FROM campaign_fingerprints AS fingerprint
            JOIN campaign_fingerprint_features AS feature
              ON feature.snapshot_id = fingerprint.snapshot_id
            CROSS JOIN LATERAL jsonb_array_elements_text(
                COALESCE(fingerprint.actors::jsonb, '[]'::jsonb)
            ) AS actor(value)
            WHERE actor.value <> ''
            """
        )
    )


def downgrade() -> None:
    op.drop_index(
        "ix_campaign_fingerprint_actors_actor_snapshot",
        table_name="campaign_fingerprint_actors",
    )
    op.drop_table("campaign_fingerprint_actors")
    op.drop_index(
        "ix_campaign_fingerprint_features_mint_created",
        table_name="campaign_fingerprint_features",
    )
    op.drop_index(
        "ix_campaign_fingerprint_features_schema_created",
        table_name="campaign_fingerprint_features",
    )
    op.drop_table("campaign_fingerprint_features")
