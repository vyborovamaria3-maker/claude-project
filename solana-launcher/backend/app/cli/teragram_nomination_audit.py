from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _quote_sql(value: str | Path) -> str:
    return "'" + str(value).replace("\\", "/").replace("'", "''") + "'"


def _csv_relation(path: Path) -> str:
    return (
        f"read_csv_auto({_quote_sql(path.resolve())}, header=true, ignore_errors=true, "
        "sample_size=200000, compression='auto', quote='\"', escape='\"')"
    )


def _columns(connection: Any, relation: str) -> set[str]:
    return {
        str(row[0])
        for row in connection.execute(f"DESCRIBE SELECT * FROM {relation}").fetchall()
    }


def _pick(columns: set[str], *names: str) -> str | None:
    for name in names:
        if name in columns:
            return name
    return None


def _select_expr(
    columns: set[str],
    name: str | None,
    alias: str,
    default: str,
    cast: str,
) -> str:
    if name is None:
        return f"TRY_CAST({default} AS {cast}) AS {alias}"
    return f"COALESCE(TRY_CAST(c.{name} AS {cast}), TRY_CAST({default} AS {cast})) AS {alias}"


def _require_file(root: Path, filename: str) -> Path:
    path = root / filename
    if not path.is_file():
        raise FileNotFoundError(f"Missing dataset file: {path}")
    return path


def run_audit(
    *,
    input_dir: Path,
    output_dir: Path,
    max_candidates: int,
    threads: int | None,
    memory_limit: str,
) -> dict[str, Any]:
    try:
        import duckdb
    except ImportError as exc:  # pragma: no cover - manual environment guard
        raise RuntimeError("TeraGram nomination audit requires duckdb.") from exc

    messages_path = _require_file(input_dir, "messages.csv")
    urls_path = _require_file(input_dir, "entity_urls.csv")
    hashtags_path = _require_file(input_dir, "hashtags.csv")
    chats_path = _require_file(input_dir, "chats.csv")

    output_dir.mkdir(parents=True, exist_ok=True)
    database_path = output_dir / "historical_nomination_audit.duckdb"
    candidates_path = output_dir / "historical_nomination_candidates.jsonl"
    audit_path = output_dir / "historical_nomination_audit.json"
    temp_dir = output_dir / "duckdb_tmp"
    temp_dir.mkdir(parents=True, exist_ok=True)

    connection = duckdb.connect(str(database_path))
    try:
        if threads is not None:
            connection.execute(f"SET threads TO {int(threads)}")
        connection.execute(f"SET memory_limit TO {_quote_sql(memory_limit)}")
        connection.execute(f"SET temp_directory TO {_quote_sql(temp_dir.resolve())}")

        connection.execute(f"CREATE OR REPLACE VIEW tg_messages AS SELECT * FROM {_csv_relation(messages_path)}")
        connection.execute(f"CREATE OR REPLACE VIEW tg_entity_urls AS SELECT * FROM {_csv_relation(urls_path)}")
        connection.execute(f"CREATE OR REPLACE VIEW tg_hashtags AS SELECT * FROM {_csv_relation(hashtags_path)}")
        connection.execute(f"CREATE OR REPLACE VIEW tg_chats AS SELECT * FROM {_csv_relation(chats_path)}")

        message_columns = _columns(connection, "tg_messages")
        url_columns = _columns(connection, "tg_entity_urls")
        hashtag_columns = _columns(connection, "tg_hashtags")
        chat_columns = _columns(connection, "tg_chats")

        for table, columns, required in (
            ("messages.csv", message_columns, {"id", "chat_id"}),
            ("entity_urls.csv", url_columns, {"message_id", "url"}),
            ("hashtags.csv", hashtag_columns, {"message_id", "hashtag"}),
            ("chats.csv", chat_columns, {"id"}),
        ):
            missing = sorted(required - columns)
            if missing:
                raise ValueError(f"{table} is missing required columns: {', '.join(missing)}")

        telegram_id_column = _pick(chat_columns, "telegram_id")
        username_column = _pick(chat_columns, "name", "username")
        title_column = _pick(chat_columns, "title")
        description_column = _pick(chat_columns, "description")
        subscribers_column = _pick(
            chat_columns,
            "members_count",
            "n_subscribers",
            "subscribers",
            "subscriber_count",
            "participants_count",
            "member_count",
        )
        scam_column = _pick(chat_columns, "is_scam", "scam")
        verified_column = _pick(chat_columns, "is_verified", "verified")

        date_expr = (
            "TRY_CAST(m.date AS TIMESTAMP)"
            if "date" in message_columns
            else "CAST(NULL AS TIMESTAMP)"
        )
        channel_id_expr = (
            "COALESCE(TRY_CAST(c.telegram_id AS VARCHAR), TRY_CAST(c.id AS VARCHAR))"
            if telegram_id_column
            else "TRY_CAST(c.id AS VARCHAR)"
        )

        native_pattern = (
            r"(?:pump[.]fun|(^|[./])solscan([./]|$)|(^|[./])raydium([./]|$))"
        )
        solana_pattern = (
            r"(?:"
            r"(^|[^a-z0-9_])(?:solana|[$]sol|raydium|solscan|pumpfun)([^a-z0-9_]|$)"
            r"|pump[.]fun|(^|[^a-z0-9_])spl[[:space:]]*token([^a-z0-9_]|$)"
            r")"
        )
        memecoin_pattern = (
            r"(^|[^a-z0-9_])"
            r"(?:memecoins?|meme[[:space:]]+coins?|meme[[:space:]]+tokens?)"
            r"([^a-z0-9_]|$)"
        )

        connection.execute(
            """
            CREATE OR REPLACE TEMP TABLE audit_entity_rows AS
            SELECT
                m.chat_id,
                u.message_id,
                """
            + date_expr
            + """ AS message_date,
                COALESCE(TRY_CAST(u.url AS VARCHAR), '') AS evidence
            FROM tg_entity_urls AS u
            INNER JOIN tg_messages AS m ON m.id = u.message_id
            WHERE u.message_id IS NOT NULL
              AND m.chat_id IS NOT NULL
              AND COALESCE(TRY_CAST(u.url AS VARCHAR), '') <> ''

            UNION ALL

            SELECT
                m.chat_id,
                h.message_id,
                """
            + date_expr
            + """ AS message_date,
                '#' || COALESCE(TRY_CAST(h.hashtag AS VARCHAR), '') AS evidence
            FROM tg_hashtags AS h
            INNER JOIN tg_messages AS m ON m.id = h.message_id
            WHERE h.message_id IS NOT NULL
              AND m.chat_id IS NOT NULL
              AND COALESCE(TRY_CAST(h.hashtag AS VARCHAR), '') <> ''
            """
        )

        connection.execute(
            f"""
            CREATE OR REPLACE TEMP TABLE audit_target_rows AS
            SELECT *
            FROM (
                SELECT
                    chat_id,
                    message_id,
                    MAX(message_date) AS message_date,
                    MAX(
                        CASE WHEN regexp_matches(lower(evidence), {_quote_sql(native_pattern)})
                        THEN 1 ELSE 0 END
                    )::BIGINT AS native_hit,
                    MAX(
                        CASE WHEN regexp_matches(lower(evidence), {_quote_sql(solana_pattern)})
                        THEN 1 ELSE 0 END
                    )::BIGINT AS solana_hit,
                    MAX(
                        CASE WHEN regexp_matches(lower(evidence), {_quote_sql(memecoin_pattern)})
                        THEN 1 ELSE 0 END
                    )::BIGINT AS memecoin_hit
                FROM audit_entity_rows
                GROUP BY chat_id, message_id
            ) AS scored
            WHERE native_hit = 1
               OR solana_hit = 1
               OR memecoin_hit = 1
            """
        )

        connection.execute(
            """
            CREATE OR REPLACE TEMP TABLE audit_message_totals AS
            SELECT chat_id, COUNT(*)::BIGINT AS total_messages
            FROM tg_messages
            WHERE chat_id IS NOT NULL
            GROUP BY chat_id
            """
        )

        connection.execute(
            """
            CREATE OR REPLACE TEMP TABLE audit_chat_signals AS
            SELECT
                chat_id,
                COUNT(*)::BIGINT AS target_messages,
                SUM(native_hit)::BIGINT AS native_messages,
                SUM(solana_hit)::BIGINT AS solana_messages,
                SUM(memecoin_hit)::BIGINT AS memecoin_messages,
                COUNT(DISTINCT CAST(message_date AS DATE))::BIGINT AS target_days,
                COUNT(
                    DISTINCT CASE
                        WHEN native_hit = 1 THEN CAST(message_date AS DATE)
                        ELSE NULL
                    END
                )::BIGINT AS native_days,
                MAX(message_date) AS last_target
            FROM audit_target_rows
            GROUP BY chat_id
            """
        )

        candidate_sql = f"""
            SELECT
                TRY_CAST(c.id AS VARCHAR) AS teragram_chat_id,
                {channel_id_expr} AS channel_id,
                {_select_expr(chat_columns, username_column, "username", "''", "VARCHAR")},
                {_select_expr(chat_columns, title_column, "title", "''", "VARCHAR")},
                {_select_expr(chat_columns, description_column, "description", "''", "VARCHAR")},
                {_select_expr(chat_columns, scam_column, "scam", "FALSE", "BOOLEAN")},
                {_select_expr(chat_columns, verified_column, "verified", "FALSE", "BOOLEAN")},
                {_select_expr(chat_columns, subscribers_column, "n_subscribers", "0", "BIGINT")},
                COALESCE(t.total_messages, 0)::BIGINT AS total_messages,
                COALESCE(s.target_messages, 0)::BIGINT AS target_messages,
                COALESCE(s.native_messages, 0)::BIGINT AS native_messages,
                COALESCE(s.solana_messages, 0)::BIGINT AS solana_messages,
                COALESCE(s.memecoin_messages, 0)::BIGINT AS memecoin_messages,
                COALESCE(s.target_days, 0)::BIGINT AS target_days,
                COALESCE(s.native_days, 0)::BIGINT AS native_days,
                CASE
                    WHEN COALESCE(t.total_messages, 0) > 0
                    THEN COALESCE(s.target_messages, 0)::DOUBLE / t.total_messages::DOUBLE
                    ELSE 0.0
                END AS target_density,
                s.last_target,
                CASE
                    WHEN COALESCE(s.native_messages, 0) >= 2
                     AND COALESCE(s.native_days, 0) >= 2
                    THEN 'native'
                    WHEN COALESCE(s.target_messages, 0) >= 3
                     AND COALESCE(s.target_days, 0) >= 2
                    THEN 'repeated'
                    ELSE 'single'
                END AS nomination_path
            FROM audit_chat_signals AS s
            INNER JOIN tg_chats AS c ON c.id = s.chat_id
            LEFT JOIN audit_message_totals AS t ON t.chat_id = s.chat_id
            ORDER BY
                CASE nomination_path
                    WHEN 'native' THEN 0
                    WHEN 'repeated' THEN 1
                    ELSE 2
                END,
                target_messages DESC,
                n_subscribers DESC
        """

        rows = connection.execute(candidate_sql + f" LIMIT {int(max_candidates)}").fetchall()
        columns = [item[0] for item in connection.description]
        with candidates_path.open("w", encoding="utf-8") as handle:
            for values in rows:
                payload = dict(zip(columns, values, strict=True))
                if isinstance(payload.get("last_target"), datetime):
                    payload["last_target"] = payload["last_target"].isoformat()
                signals = {
                    "messages_total": int(payload.pop("total_messages") or 0),
                    "target_messages": int(payload.pop("target_messages") or 0),
                    "native_messages": int(payload.pop("native_messages") or 0),
                    "solana_messages": int(payload.pop("solana_messages") or 0),
                    "memecoin_messages": int(payload.pop("memecoin_messages") or 0),
                    "target_days": int(payload.pop("target_days") or 0),
                    "native_days": int(payload.pop("native_days") or 0),
                    "target_density": float(payload.pop("target_density") or 0.0),
                }
                classifications = ["crypto"]
                if signals["solana_messages"] > 0:
                    classifications.append("solana")
                if signals["memecoin_messages"] > 0:
                    classifications.append("memecoin")
                if "solana" in classifications and "memecoin" in classifications:
                    classifications.append("solana_memecoin")
                payload["signals"] = signals
                payload["classifications"] = classifications
                payload["seed_score"] = 55.0 if payload["nomination_path"] == "native" else 45.0
                handle.write(json.dumps(payload, ensure_ascii=False) + "\n")

        summary_row = connection.execute(
            """
            SELECT
                COUNT(*)::BIGINT AS candidate_chats,
                SUM(CASE WHEN native_messages >= 2 AND native_days >= 2 THEN 1 ELSE 0 END)::BIGINT
                    AS native_nomination_chats,
                SUM(CASE WHEN target_messages >= 3 AND target_days >= 2 THEN 1 ELSE 0 END)::BIGINT
                    AS repeated_nomination_chats,
                SUM(target_messages)::BIGINT AS target_messages,
                SUM(native_messages)::BIGINT AS native_messages,
                SUM(solana_messages)::BIGINT AS solana_messages,
                SUM(memecoin_messages)::BIGINT AS memecoin_messages
            FROM audit_chat_signals
            """
        ).fetchone()

        total_chats = connection.execute("SELECT COUNT(*) FROM tg_chats").fetchone()[0]
        total_messages = connection.execute("SELECT COUNT(*) FROM tg_messages").fetchone()[0]
        audit = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "input_dir": str(input_dir),
            "outputs": {
                "audit_json": str(audit_path),
                "candidates_jsonl": str(candidates_path),
                "duckdb_path": str(database_path),
            },
            "schema": {
                "chats": sorted(chat_columns),
                "messages": sorted(message_columns),
                "entity_urls": sorted(url_columns),
                "hashtags": sorted(hashtag_columns),
                "selected_chat_columns": {
                    "username": username_column,
                    "title": title_column,
                    "description": description_column,
                    "subscribers": subscribers_column,
                    "scam": scam_column,
                    "verified": verified_column,
                },
            },
            "totals": {
                "chats": int(total_chats or 0),
                "messages": int(total_messages or 0),
                "candidate_chats": int(summary_row[0] or 0),
                "native_nomination_chats": int(summary_row[1] or 0),
                "repeated_nomination_chats": int(summary_row[2] or 0),
                "target_messages": int(summary_row[3] or 0),
                "native_messages": int(summary_row[4] or 0),
                "solana_messages": int(summary_row[5] or 0),
                "memecoin_messages": int(summary_row[6] or 0),
                "written_candidates": len(rows),
            },
            "safety_note": (
                "Candidates are historical nominations only. Live Telegram availability and "
                "current relevance must be revalidated before operational use."
            ),
        }
        audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
        return audit
    finally:
        connection.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run a schema-adaptive dataset-wide TeraGram nomination audit."
    )
    parser.add_argument(
        "--input-dir",
        default=os.environ.get("TERAGRAM_INPUT_DIR"),
        help="TeraGram CSV root. Defaults to TERAGRAM_INPUT_DIR.",
    )
    parser.add_argument(
        "--output",
        default="data/teragram_historical_temporal_test/dataset_wide",
        help="audit output directory",
    )
    parser.add_argument("--max-candidates", type=int, default=5000)
    parser.add_argument("--threads", type=int, default=None)
    parser.add_argument("--memory-limit", default="4GB")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if not args.input_dir:
        parser.error("--input-dir or TERAGRAM_INPUT_DIR is required")
    if args.max_candidates < 1:
        parser.error("--max-candidates must be positive")
    if args.threads is not None and args.threads < 1:
        parser.error("--threads must be positive")

    audit = run_audit(
        input_dir=Path(args.input_dir),
        output_dir=Path(args.output),
        max_candidates=args.max_candidates,
        threads=args.threads,
        memory_limit=args.memory_limit,
    )
    print(json.dumps(audit, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
