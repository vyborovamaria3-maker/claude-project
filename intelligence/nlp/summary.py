"""As-of safe, source-level summaries over locally derived sentiment results.

Sentiment across models is NEVER merged into an unlabeled 'bullish' score.
A message observed earlier but inferred later cannot leak into past backtests.
No token attribution is performed by this module.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from intelligence.nlp.sentiment import MODELS


def summarize_as_of(path: str | Path, as_of: datetime, source: str | None = None) -> list[dict[str, Any]]:
    if not isinstance(as_of, datetime) or as_of.tzinfo is None or as_of.utcoffset() is None:
        raise ValueError("as_of must be timezone aware")
    if source not in (None, "x", "tg"):
        raise ValueError("source must be x or tg")
    utc = as_of.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    file = Path(path)
    if not file.is_absolute() or not file.is_file():
        raise ValueError("existing absolute result database path required")
    # URI mode=ro stops SQLite from creating a file and enables read-only
    # access even if source file is accidentally pointed at a source DB.
    connection = sqlite3.connect(file.as_uri() + "?mode=ro", uri=True)
    try:
        query = """
            SELECT source, model_key, COUNT(*) AS n, MIN(inference_at),
                   MAX(inference_at)
            FROM sentiment_predictions
            WHERE observed_at <= ? AND inference_at <= ?
        """
        values: list[str] = [utc, utc]
        if source is not None:
            query += " AND source = ?"
            values.append(source)
        query += " GROUP BY source, model_key ORDER BY source, model_key"
        groups = connection.execute(query, values).fetchall()
        result = []
        for source_name, model_key, count, first, last in groups:
            if model_key not in MODELS:
                raise ValueError("unrecognized model in results")
            # Aggregation done inside the DB with JSON functions and bound
            # parameters: never silently mix positive with bullish.
            labels = MODELS[model_key].labels
            label_query = (
                "SELECT " +
                ", ".join("AVG(CAST(json_extract(probabilities_json, ?) AS REAL))"
                          for _ in labels) +
                " FROM sentiment_predictions WHERE observed_at<=? "
                "AND inference_at<=? AND source=? AND model_key=?"
            )
            paths = ["$." + label for label in labels]
            averages = connection.execute(label_query, paths + [
                utc, utc, source_name, model_key
            ]).fetchone()
            result.append({
                "source": source_name, "model_key": model_key,
                "task": MODELS[model_key].task, "observations": count,
                "first_inference_at": first, "last_inference_at": last,
                "average_probabilities": dict(zip(
                    labels, (float(v) for v in averages), strict=True
                )),
                "as_of": utc,
            })
        return result
    finally:
        connection.close()
