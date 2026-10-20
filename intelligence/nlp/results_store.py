"""Local derived sentiment results, separate from collector and source evidence DBs.

No text or provider credentials are saved.  The model revision and preprocessor
version are part of the key so a model refresh cannot silently rewrite history.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Sequence

from intelligence.nlp.sentiment import MODELS, SCHEMA_VERSION


DDL = """
CREATE TABLE IF NOT EXISTS sentiment_predictions (
  source TEXT NOT NULL CHECK(source IN ('x', 'tg')),
  source_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  preprocess_version TEXT NOT NULL,
  model_key TEXT NOT NULL,
  model_repository TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  task TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  inference_at TEXT NOT NULL,
  language TEXT NOT NULL,
  probabilities_json TEXT NOT NULL CHECK(json_valid(probabilities_json)),
  schema_version TEXT NOT NULL CHECK(schema_version='sentiment-v1'),
  PRIMARY KEY(source, source_id, content_sha256,
              preprocess_version, model_key, model_revision)
);
CREATE INDEX IF NOT EXISTS sentiment_predictions_source_observed_idx
  ON sentiment_predictions(source, observed_at DESC, source_id);
"""


def _check_result(record: dict[str, Any]) -> None:
    """Enforce the provenance schema even for direct API callers."""
    if not isinstance(record, dict) or record.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("invalid sentiment result schema")
    for field in ("source", "source_id", "content_sha256", "preprocess_version",
                  "observed_at", "occurred_at", "inference_at", "language"):
        if not isinstance(record.get(field), str) or not record[field]:
            raise ValueError("invalid sentiment result field: " + field)
    if record["source"] not in ("x", "tg"):
        raise ValueError("invalid result source")
    if len(record["content_sha256"]) != 64 or any(c not in "0123456789abcdef"
                                                    for c in record["content_sha256"]):
        raise ValueError("invalid content digest")
    if not isinstance(record.get("model_results"), dict):
        raise ValueError("missing sentiment model results")


def store_predictions(db_path: str | Path, records: Sequence[dict[str, Any]]) -> int:
    """Store one bounded inference batch atomically; return newly inserted models."""
    if len(records) > 1000:
        raise ValueError("too many sentiment records")
    path = Path(db_path).expanduser()
    if str(path) == ":memory:":
        raise ValueError("persistent results require a real SQLite path")
    if not path.is_absolute():
        raise ValueError("results path must be absolute")
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(path), timeout=10, isolation_level=None)
    try:
        # Refuse any existing collector or Intelligence runtime database before
        # writing PRAGMAs or creating derived result tables.
        protected = {"tg_messages", "twitter_tweets", "chain_seed_events",
                     "intelligence_documents", "intelligence_jobs", "outbox_events"}
        found = {row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        if found.intersection(protected):
            raise ValueError("results DB must be separate from source/runtime DBs")
        db.execute("PRAGMA busy_timeout=10000")
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript(DDL)
        db.execute("BEGIN IMMEDIATE")
        inserted = 0
        try:
            for record in records:
                _check_result(record)
                for key, model in record["model_results"].items():
                    spec = MODELS.get(key)
                    if spec is None or not isinstance(model, dict):
                        raise ValueError("unknown model result")
                    if model.get("model") != spec.repository or model.get("task") != spec.task:
                        raise ValueError("model identity differs from approved contract")
                    revision = model.get("revision")
                    if not isinstance(revision, str) or len(revision) != 40 or any(
                        c not in "0123456789abcdef" for c in revision
                    ):
                        raise ValueError("invalid pinned model revision")
                    probabilities = model.get("labels")
                    if not isinstance(probabilities, dict) or set(probabilities) != set(spec.labels):
                        raise ValueError("model labels mismatch")
                    # Engine already validates probabilities; sink also rejects
                    # unknown/replayed externally fabricated payloads.
                    import math
                    if (any(type(p) not in (int, float) or not math.isfinite(p)
                            or p < 0 or p > 1 for p in probabilities.values())
                            or abs(sum(probabilities.values())-1) > 0.002):
                        raise ValueError("invalid model probabilities")
                    payload = json.dumps(probabilities, sort_keys=True, separators=(",", ":"))
                    c = db.execute(
                        """INSERT OR IGNORE INTO sentiment_predictions (
                          source,source_id,content_sha256,preprocess_version,
                          model_key,model_repository,model_revision,task,
                          observed_at,occurred_at,inference_at,language,
                          probabilities_json,schema_version
                        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            record["source"], record["source_id"], record["content_sha256"],
                            record["preprocess_version"], key, model["model"],
                            revision, model["task"], record["observed_at"],
                            record["occurred_at"], record["inference_at"],
                            record["language"], payload, record["schema_version"],
                        ),
                    )
                    inserted += c.rowcount
            db.execute("COMMIT")
            return inserted
        except Exception:
            db.execute("ROLLBACK")
            raise
    finally:
        db.close()
