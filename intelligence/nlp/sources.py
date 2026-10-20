"""Read-only, operator-initiated text snapshots from existing X/TG PostgreSQL.

Does not authenticate to X/TG, start collection, copy raw message text into
Intelligence storage, infer asset identity, or write to collector databases.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from datetime import datetime
from typing import Any

from intelligence.nlp.sentiment import SourceText


# Column shapes from the current X and TG collectors. Fully parameterized,
# hard-coded queries: source names are never interpolated into SQL.
_X_QUERY = """
SELECT tweet_id, text, updated_at, posted_at
FROM twitter_tweets
WHERE text IS NOT NULL AND btrim(text) <> ''
  AND tweet_id ~ '^[1-9][0-9]*$'
ORDER BY updated_at DESC, tweet_id DESC LIMIT %s
"""
_TG_QUERY = """
SELECT s.peer_id, m.message_id, m.text, m.collected_at, m.posted_at
FROM tg_messages AS m JOIN tg_sources AS s ON s.id=m.source_id
WHERE m.deleted_at IS NULL AND m.text IS NOT NULL AND btrim(m.text) <> ''
  AND s.peer_id ~ '^-?[1-9][0-9]*$'
ORDER BY m.collected_at DESC, m.source_id, m.message_id DESC LIMIT %s
"""


def read_collector_texts(
    source: str, *, dsn: str, limit: int = 100, connect: Callable[..., Any] | None = None,
) -> list[SourceText]:
    if source not in ("x", "tg"):
        raise ValueError("source must be x or tg")
    if not isinstance(dsn, str) or not dsn.strip():
        raise ValueError("collector DSN must be configured locally")
    if not isinstance(limit, int) or not 1 <= limit <= 1000:
        raise ValueError("limit must be 1..1000")
    if connect is None:
        # psycopg already belongs to normal Intelligence dependencies.
        import psycopg
        connect = psycopg.connect

    output: list[SourceText] = []
    # SET TRANSACTION READ ONLY applies to the current transaction. The DB
    # login itself should ALSO be restricted to SELECT by the operator.
    with connect(dsn, connect_timeout=5) as db:
        with db.cursor() as cursor:
            cursor.execute("SET TRANSACTION READ ONLY")
            cursor.execute(_X_QUERY if source == "x" else _TG_QUERY, (limit,))
            for row in cursor.fetchall():
                if source == "x":
                    tweet_id, text, observed_at, occurred_at = row
                    source_id = "x:tweet:" + str(tweet_id)
                else:
                    peer_id, message_id, text, observed_at, occurred_at = row
                    source_id = "tg:message:" + str(peer_id) + ":" + str(message_id)
                if not isinstance(text, str) or not text.strip() or len(text) > 16000:
                    # Oversized/empty entries are explicitly not inferred.
                    continue
                if not isinstance(observed_at, datetime) or observed_at.tzinfo is None:
                    raise ValueError("source timestamps must include timezone")
                output.append(SourceText(source, source_id, text, observed_at, occurred_at))
    return output
