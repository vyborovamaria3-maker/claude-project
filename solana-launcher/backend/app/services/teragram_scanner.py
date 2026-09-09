from __future__ import annotations

import heapq
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator, TextIO

from app.services.tgdataset_scanner import TGDatasetChannelAccumulator, utcnow_iso


TERAGRAM_PREVIEW_RECORD_ID = 18262126
TERAGRAM_PREVIEW_VERSION = "0.1.0"
TERAGRAM_PREVIEW_LATEST_DOI = "10.5281/zenodo.18262125"
TERAGRAM_FULL_DOI = "10.25625/GDCXQK"
TERAGRAM_UPSTREAM_REPOSITORY = "https://github.com/Priesemann-Group/telegram_quality_control"

_TABLE_ALIASES: dict[str, tuple[str, ...]] = {
    "chats": ("chats",),
    "messages": ("messages",),
    "message_content": ("message_content",),
    "entity_urls": ("entity_urls", "urls"),
    "entity_hashtags": ("entity_hashtags", "hashtags"),
}

# DuckDB uses RE2, so keep this pre-gate free of lookbehind/backreferences. The exact
# Solana-address validation still happens in TGDatasetChannelAccumulator via telegram_parser.
_TERAGRAM_GATE_PATTERN = (
    r"(?:crypto|bitcoin|\bbtc\b|ethereum|\beth\b|blockchain|web3|defi|dex|binance|\bbnb\b|"
    r"altcoin|airdrop|token|coin|meme|doge|shib|floki|safemoon|pepe|bonk|solana|raydium|"
    r"jupiter|pump\.fun|pumpfun|dexscreener|birdeye|gmgn|photon|bullx|0x[0-9a-f]{40}|"
    r"\$[a-z][a-z0-9_]{1,11}|(?:contract|mcap|gem|presale|launch|100x|50x|20x|10x))"
)
_MEMORY_LIMIT_RE = re.compile(r"^[1-9][0-9]*(?:MB|GB|TB)$", re.IGNORECASE)
_SEED_CLASSES = {"memecoin", "solana", "caller", "memecoin_calls", "solana_memecoin"}


@dataclass(frozen=True, slots=True)
class TeraGramSources:
    root: Path
    chats: tuple[Path, ...]
    messages: tuple[Path, ...]
    message_content: tuple[Path, ...]
    entity_urls: tuple[Path, ...]
    entity_hashtags: tuple[Path, ...]

    @property
    def has_content(self) -> bool:
        return bool(self.message_content)

    @property
    def has_entities(self) -> bool:
        return bool(self.entity_urls or self.entity_hashtags)

    def as_dict(self) -> dict[str, list[str] | str]:
        return {
            "root": str(self.root),
            "chats": [str(path) for path in self.chats],
            "messages": [str(path) for path in self.messages],
            "message_content": [str(path) for path in self.message_content],
            "entity_urls": [str(path) for path in self.entity_urls],
            "entity_hashtags": [str(path) for path in self.entity_hashtags],
        }


def _discover_table(root: Path, aliases: tuple[str, ...]) -> tuple[Path, ...]:
    parquet: list[Path] = []
    csv: list[Path] = []
    for alias in aliases:
        direct_parquet = root / f"{alias}.parquet"
        direct_csv = root / f"{alias}.csv"
        if direct_parquet.is_file():
            parquet.append(direct_parquet)
        if direct_csv.is_file():
            csv.append(direct_csv)

        directory = root / alias
        if directory.is_dir():
            parquet.extend(sorted(path for path in directory.glob("*.parquet") if path.is_file()))
            csv.extend(sorted(path for path in directory.glob("*.csv") if path.is_file()))

    # Never mix formats for one logical relation. The full dataset is Parquet and the preview
    # is CSV; preferring Parquet makes an accidentally co-located preview harmless.
    selected = parquet or csv
    return tuple(dict.fromkeys(path.resolve() for path in selected))


def discover_teragram_sources(input_dir: str | Path) -> TeraGramSources:
    root = Path(input_dir).expanduser().resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"TeraGram input directory does not exist: {root}")

    sources = TeraGramSources(
        root=root,
        chats=_discover_table(root, _TABLE_ALIASES["chats"]),
        messages=_discover_table(root, _TABLE_ALIASES["messages"]),
        message_content=_discover_table(root, _TABLE_ALIASES["message_content"]),
        entity_urls=_discover_table(root, _TABLE_ALIASES["entity_urls"]),
        entity_hashtags=_discover_table(root, _TABLE_ALIASES["entity_hashtags"]),
    )
    if not sources.chats:
        raise FileNotFoundError(
            "TeraGram chats table was not found. Expected chats.csv, chats.parquet, or "
            "chats/*.parquet under the input directory."
        )
    if not sources.messages:
        raise FileNotFoundError(
            "TeraGram messages table was not found. Expected messages.csv, messages.parquet, "
            "or messages/*.parquet under the input directory."
        )
    return sources


def _require_duckdb() -> Any:
    try:
        import duckdb
    except ImportError as exc:  # pragma: no cover - dependency guard for manual environments
        raise RuntimeError(
            "TeraGram scanning requires DuckDB. Install backend TeraGram extras with "
            '`pip install -e ".[teragram]"`.'
        ) from exc
    return duckdb


def _quote_sql(value: str | Path) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _relation_sql(paths: tuple[Path, ...]) -> str:
    if not paths:
        raise ValueError("relation requires at least one source file")
    file_list = "[" + ", ".join(_quote_sql(path) for path in paths) + "]"
    if all(path.suffix.lower() == ".parquet" for path in paths):
        return f"read_parquet({file_list}, union_by_name=true)"
    if all(path.suffix.lower() == ".csv" for path in paths):
        return (
            f"read_csv_auto({file_list}, header=true, union_by_name=true, sample_size=20000, "
            "ignore_errors=false)"
        )
    raise ValueError("TeraGram relation files must all be CSV or all be Parquet")


def _columns(connection: Any, view_name: str) -> set[str]:
    rows = connection.execute(f"DESCRIBE SELECT * FROM {view_name}").fetchall()
    return {str(row[0]) for row in rows}


def _require_columns(view_name: str, actual: set[str], required: set[str]) -> None:
    missing = sorted(required - actual)
    if missing:
        raise ValueError(f"TeraGram table {view_name} is missing required columns: {', '.join(missing)}")


def _column_expr(columns: set[str], name: str, *, default: str, cast: str = "VARCHAR") -> str:
    if name not in columns:
        return default
    return f"TRY_CAST({name} AS {cast})"


def _configure_duckdb(
    connection: Any,
    *,
    threads: int | None,
    memory_limit: str,
    temp_dir: Path,
) -> None:
    if threads is not None:
        if threads < 1:
            raise ValueError("threads must be positive")
        connection.execute(f"PRAGMA threads={min(threads, 256)}")
    memory_limit = memory_limit.strip().upper()
    if not _MEMORY_LIMIT_RE.fullmatch(memory_limit):
        raise ValueError("memory_limit must look like 512MB, 4GB, or 1TB")
    temp_dir.mkdir(parents=True, exist_ok=True)
    connection.execute(f"SET memory_limit={_quote_sql(memory_limit)}")
    connection.execute(f"SET temp_directory={_quote_sql(temp_dir.resolve())}")
    connection.execute("SET preserve_insertion_order=false")


def _create_source_views(connection: Any, sources: TeraGramSources) -> dict[str, set[str]]:
    relation_sources = {
        "tg_chats": sources.chats,
        "tg_messages": sources.messages,
        "tg_message_content": sources.message_content,
        "tg_entity_urls": sources.entity_urls,
        "tg_entity_hashtags": sources.entity_hashtags,
    }
    result: dict[str, set[str]] = {}
    for view_name, paths in relation_sources.items():
        if not paths:
            result[view_name] = set()
            continue
        connection.execute(
            f"CREATE OR REPLACE TEMP VIEW {view_name} AS SELECT * FROM {_relation_sql(paths)}"
        )
        result[view_name] = _columns(connection, view_name)

    _require_columns("chats", result["tg_chats"], {"id"})
    _require_columns("messages", result["tg_messages"], {"id", "chat_id"})
    if result["tg_message_content"]:
        _require_columns("message_content", result["tg_message_content"], {"message_id"})
    if result["tg_entity_urls"]:
        _require_columns("entity_urls", result["tg_entity_urls"], {"message_id", "url"})
    if result["tg_entity_hashtags"]:
        _require_columns(
            "entity_hashtags", result["tg_entity_hashtags"], {"message_id", "hashtag"}
        )
    return result


def _resolved_signal_source(
    requested: str,
    *,
    has_content: bool,
    has_entities: bool,
) -> str:
    if requested not in {"auto", "content", "entities", "metadata"}:
        raise ValueError("signal_source must be auto, content, entities, or metadata")
    if requested == "auto":
        if has_content:
            return "content"
        if has_entities:
            return "entities"
        return "metadata"
    if requested == "content" and not has_content:
        raise ValueError("signal_source=content requested but message_content table is unavailable")
    if requested == "entities" and not has_entities:
        raise ValueError("signal_source=entities requested but URL/hashtag tables are unavailable")
    return requested


def _create_signal_table(
    connection: Any,
    columns: dict[str, set[str]],
    *,
    signal_source: str,
) -> None:
    # Materialize the cheap pre-gate once. On full TeraGram, re-reading entity/content tables for
    # candidate discovery and again for exact scoring would otherwise duplicate the most expensive scan.
    if signal_source == "content":
        content_columns = columns["tg_message_content"]
        text_parts: list[str] = []
        if "text" in content_columns:
            text_parts.append("COALESCE(TRY_CAST(mc.text AS VARCHAR), '')")
        if "caption" in content_columns:
            text_parts.append("COALESCE(TRY_CAST(mc.caption AS VARCHAR), '')")
        if not text_parts:
            raise ValueError("message_content table has neither text nor caption columns")
        evidence = " || ' ' || ".join(text_parts)
        connection.execute(
            f"""
            CREATE OR REPLACE TEMP TABLE tg_signal_rows AS
            SELECT q.chat_id, q.message_id, q.signal_text
            FROM (
                SELECT
                    m.chat_id,
                    mc.message_id,
                    TRIM({evidence}) AS signal_text
                FROM tg_message_content AS mc
                INNER JOIN tg_messages AS m ON m.id = mc.message_id
            ) AS q
            WHERE q.chat_id IS NOT NULL
              AND q.signal_text <> ''
              AND regexp_matches(lower(q.signal_text), {_quote_sql(_TERAGRAM_GATE_PATTERN)})
            """
        )
        return

    if signal_source == "entities":
        parts: list[str] = []
        if columns["tg_entity_urls"]:
            parts.append(
                "SELECT message_id, COALESCE(TRY_CAST(url AS VARCHAR), '') AS evidence "
                "FROM tg_entity_urls"
            )
        if columns["tg_entity_hashtags"]:
            parts.append(
                "SELECT message_id, '#' || COALESCE(TRY_CAST(hashtag AS VARCHAR), '') AS evidence "
                "FROM tg_entity_hashtags"
            )
        entity_union = " UNION ALL ".join(parts)
        connection.execute(
            f"""
            CREATE OR REPLACE TEMP TABLE tg_signal_rows AS
            WITH entity_parts AS (
                {entity_union}
            ), grouped AS (
                SELECT message_id, string_agg(evidence, ' ') AS signal_text
                FROM entity_parts
                WHERE evidence <> ''
                GROUP BY message_id
            )
            SELECT m.chat_id, grouped.message_id, grouped.signal_text
            FROM grouped
            INNER JOIN tg_messages AS m ON m.id = grouped.message_id
            WHERE m.chat_id IS NOT NULL
              AND regexp_matches(lower(grouped.signal_text), {_quote_sql(_TERAGRAM_GATE_PATTERN)})
            """
        )
        return

    connection.execute(
        """
        CREATE OR REPLACE TEMP TABLE tg_signal_rows AS
        SELECT
            CAST(NULL AS BIGINT) AS chat_id,
            CAST(NULL AS BIGINT) AS message_id,
            CAST(NULL AS VARCHAR) AS signal_text
        WHERE FALSE
        """
    )


def _create_candidate_tables(
    connection: Any,
    columns: dict[str, set[str]],
    *,
    max_chats: int | None,
) -> None:
    chat_columns = columns["tg_chats"]
    metadata_parts: list[str] = []
    for name in ("name", "title", "description"):
        if name in chat_columns:
            metadata_parts.append(f"COALESCE(TRY_CAST({name} AS VARCHAR), '')")
    metadata_evidence = " || ' ' || ".join(metadata_parts) if metadata_parts else "''"

    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE tg_candidate_chat_ids AS
        SELECT id AS chat_id
        FROM tg_chats
        WHERE regexp_matches(lower({metadata_evidence}), {_quote_sql(_TERAGRAM_GATE_PATTERN)})
        UNION
        SELECT DISTINCT chat_id
        FROM tg_signal_rows
        WHERE chat_id IS NOT NULL
        """
    )
    limit_sql = ""
    if max_chats is not None:
        if max_chats < 1:
            raise ValueError("max_chats must be positive")
        limit_sql = f" LIMIT {int(max_chats)}"
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE tg_selected_chat_ids AS
        SELECT chat_id
        FROM tg_candidate_chat_ids
        ORDER BY chat_id
        {limit_sql}
        """
    )

    message_columns = columns["tg_messages"]
    forward_checks: list[str] = []
    if "forward_from_id" in message_columns:
        forward_checks.append("m.forward_from_id IS NOT NULL")
    if "forward_from_chat_id" in message_columns:
        forward_checks.append("m.forward_from_chat_id IS NOT NULL")
    forward_expr = " OR ".join(forward_checks) if forward_checks else "FALSE"
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE tg_message_stats AS
        SELECT
            m.chat_id,
            COUNT(*)::BIGINT AS messages_total,
            SUM(CASE WHEN {forward_expr} THEN 1 ELSE 0 END)::BIGINT AS forwarded_messages
        FROM tg_messages AS m
        INNER JOIN tg_selected_chat_ids AS selected ON selected.chat_id = m.chat_id
        GROUP BY m.chat_id
        """
    )


def _chat_select_expr(columns: set[str], name: str, alias: str, default: str, cast: str) -> str:
    return f"{_column_expr(columns, name, default=default, cast=cast)} AS {alias}"


def _candidate_query(columns: dict[str, set[str]]) -> str:
    chats = columns["tg_chats"]
    channel_id_expr = (
        "COALESCE(TRY_CAST(c.telegram_id AS VARCHAR), TRY_CAST(c.id AS VARCHAR))"
        if "telegram_id" in chats
        else "TRY_CAST(c.id AS VARCHAR)"
    )
    return f"""
        SELECT
            TRY_CAST(c.id AS VARCHAR) AS teragram_chat_id,
            {channel_id_expr} AS channel_id,
            {_chat_select_expr(chats, 'name', 'username', "''", 'VARCHAR')},
            {_chat_select_expr(chats, 'title', 'title', "''", 'VARCHAR')},
            {_chat_select_expr(chats, 'description', 'description', "''", 'VARCHAR')},
            {_chat_select_expr(chats, 'is_scam', 'scam', 'FALSE', 'BOOLEAN')},
            {_chat_select_expr(chats, 'is_verified', 'verified', 'FALSE', 'BOOLEAN')},
            {_chat_select_expr(chats, 'members_count', 'n_subscribers', '0', 'BIGINT')},
            COALESCE(stats.messages_total, 0)::BIGINT AS messages_total,
            COALESCE(stats.forwarded_messages, 0)::BIGINT AS forwarded_messages,
            signals.message_id,
            signals.signal_text
        FROM tg_selected_chat_ids AS selected
        INNER JOIN tg_chats AS c ON c.id = selected.chat_id
        LEFT JOIN tg_message_stats AS stats ON stats.chat_id = c.id
        LEFT JOIN tg_signal_rows AS signals ON signals.chat_id = c.id
        ORDER BY c.id, signals.message_id
    """


class _JsonArrayWriter:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.handle: TextIO | None = None
        self.first = True

    def __enter__(self) -> _JsonArrayWriter:
        self.handle = self.path.open("w", encoding="utf-8")
        self.handle.write("[\n")
        return self

    def write(self, payload: dict[str, Any]) -> None:
        if self.handle is None:
            raise RuntimeError("JSON writer is not open")
        if not self.first:
            self.handle.write(",\n")
        self.handle.write(json.dumps(payload, ensure_ascii=False))
        self.first = False

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if self.handle is not None:
            self.handle.write("\n]\n")
            self.handle.close()
            self.handle = None


def _seed_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "username": row["username"],
        "seed_score": row["seed_score"],
        "scores": row["scores"],
        "classifications": row["classifications"],
        "n_subscribers": row["n_subscribers"],
        "channel_id": row["channel_id"],
        "teragram_chat_id": row.get("teragram_chat_id", ""),
    }


def _iter_query_rows(cursor: Any, *, fetch_size: int) -> Iterator[tuple[Any, ...]]:
    if fetch_size < 1:
        raise ValueError("fetch_size must be positive")
    while True:
        batch = cursor.fetchmany(fetch_size)
        if not batch:
            return
        yield from batch


def scan_teragram_dataset(
    *,
    input_dir: str | Path,
    output_dir: str | Path,
    seed_limit: int = 250,
    max_chats: int | None = None,
    signal_source: str = "auto",
    duckdb_path: str | Path | None = None,
    threads: int | None = None,
    memory_limit: str = "4GB",
    temp_dir: str | Path | None = None,
    fetch_size: int = 10_000,
    progress: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Filter TeraGram without materializing its multi-terabyte tables in Python memory.

    DuckDB performs columnar CSV/Parquet scans and narrows the dataset to chats/messages matching
    a cheap crypto pre-gate. Only those signal rows cross into Python, where the existing
    TGDatasetChannelAccumulator performs the exact parser/scoring logic used by the legacy scanner.

    The public TeraGram distribution does not include message text. In that case ``auto`` uses URL
    and hashtag entities; if controlled-access message_content is present, ``auto`` prefers it.
    """

    if seed_limit < 1:
        raise ValueError("seed_limit must be positive")
    sources = discover_teragram_sources(input_dir)
    output = Path(output_dir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    database = Path(duckdb_path).expanduser().resolve() if duckdb_path else output / "teragram.duckdb"
    scratch = Path(temp_dir).expanduser().resolve() if temp_dir else output / "duckdb_tmp"

    duckdb = _require_duckdb()
    connection = duckdb.connect(str(database))
    try:
        _configure_duckdb(
            connection,
            threads=threads,
            memory_limit=memory_limit,
            temp_dir=scratch,
        )
        if progress:
            progress("TeraGram: discovering CSV/Parquet relations")
        columns = _create_source_views(connection, sources)
        resolved_source = _resolved_signal_source(
            signal_source,
            has_content=bool(columns["tg_message_content"]),
            has_entities=bool(columns["tg_entity_urls"] or columns["tg_entity_hashtags"]),
        )
        if progress:
            progress(f"TeraGram: signal source = {resolved_source}")
        _create_signal_table(connection, columns, signal_source=resolved_source)
        if progress:
            progress("TeraGram: building disk-backed candidate and message indexes")
        _create_candidate_tables(connection, columns, max_chats=max_chats)

        chats_total = int(connection.execute("SELECT COUNT(*) FROM tg_chats").fetchone()[0])
        prefiltered = int(
            connection.execute("SELECT COUNT(*) FROM tg_selected_chat_ids").fetchone()[0]
        )

        candidate_path = output / "teragram_candidates.jsonl"
        category_paths = {
            "crypto": output / "crypto_channels.json",
            "memecoin": output / "memecoin_channels.json",
            "solana": output / "solana_channels.json",
            "caller": output / "caller_channels.json",
        }
        category_counts = {name: 0 for name in category_paths}
        candidates = 0
        signal_rows = 0
        seed_heap: list[tuple[float, int, int, dict[str, Any]]] = []
        seed_sequence = 0

        if progress:
            progress("TeraGram: applying exact POTAPoff Telegram parser and scoring")
        cursor = connection.execute(_candidate_query(columns))

        current: TGDatasetChannelAccumulator | None = None
        current_source_chat_id = ""
        actual_messages_total = 0
        actual_forwarded_messages = 0

        def finalize_current(
            candidate_handle: TextIO,
            category_writers: dict[str, _JsonArrayWriter],
        ) -> None:
            nonlocal current, candidates, seed_sequence
            if current is None:
                return
            observed_signal_rows = current.messages_total
            current.messages_total = max(actual_messages_total, observed_signal_rows)
            current.forwarded_messages = max(actual_forwarded_messages, current.forwarded_messages)
            row = current.result()
            row["teragram_chat_id"] = current_source_chat_id
            if not row["classifications"]:
                return

            candidates += 1
            candidate_handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            classes = set(row["classifications"])
            for category, writer in category_writers.items():
                if category in classes:
                    writer.write(row)
                    category_counts[category] += 1

            if row["username"] and not row["scam"] and classes.intersection(_SEED_CLASSES):
                seed = _seed_payload(row)
                item = (
                    float(row["seed_score"]),
                    int(row["n_subscribers"] or 0),
                    seed_sequence,
                    seed,
                )
                seed_sequence += 1
                if len(seed_heap) < seed_limit:
                    heapq.heappush(seed_heap, item)
                elif item[:2] > seed_heap[0][:2]:
                    heapq.heapreplace(seed_heap, item)

        with candidate_path.open("w", encoding="utf-8") as candidate_handle:
            with (
                _JsonArrayWriter(category_paths["crypto"]) as crypto_writer,
                _JsonArrayWriter(category_paths["memecoin"]) as memecoin_writer,
                _JsonArrayWriter(category_paths["solana"]) as solana_writer,
                _JsonArrayWriter(category_paths["caller"]) as caller_writer,
            ):
                category_writers = {
                    "crypto": crypto_writer,
                    "memecoin": memecoin_writer,
                    "solana": solana_writer,
                    "caller": caller_writer,
                }
                for values in _iter_query_rows(cursor, fetch_size=fetch_size):
                    (
                        teragram_chat_id,
                        channel_id,
                        username,
                        title,
                        description,
                        scam,
                        verified,
                        n_subscribers,
                        messages_total,
                        forwarded_messages,
                        _message_id,
                        signal_text,
                    ) = values
                    source_chat_id = str(teragram_chat_id or "")
                    if current is None or source_chat_id != current_source_chat_id:
                        finalize_current(candidate_handle, category_writers)
                        current_source_chat_id = source_chat_id
                        current = TGDatasetChannelAccumulator(
                            channel_id=str(channel_id or source_chat_id)
                        )
                        current.observe_metadata("username", username or "")
                        current.observe_metadata("title", title or "")
                        current.observe_metadata("description", description or "")
                        current.observe_metadata("scam", bool(scam))
                        current.observe_metadata("verified", bool(verified))
                        current.observe_metadata("n_subscribers", int(n_subscribers or 0))
                        actual_messages_total = int(messages_total or 0)
                        actual_forwarded_messages = int(forwarded_messages or 0)
                    if signal_text:
                        signal_rows += 1
                        current.observe_message(str(signal_text))
                finalize_current(candidate_handle, category_writers)

        seeds = [item[3] for item in sorted(seed_heap, reverse=True)]
        seed_path = output / "telegram_seed_database.json"
        seed_document = {
            "generated_at": utcnow_iso(),
            "source": "teragram",
            "source_version": {
                "preview_record_id": TERAGRAM_PREVIEW_RECORD_ID,
                "preview_version": TERAGRAM_PREVIEW_VERSION,
                "latest_preview_doi": TERAGRAM_PREVIEW_LATEST_DOI,
                "full_dataset_doi": TERAGRAM_FULL_DOI,
            },
            "signal_source": resolved_source,
            "channels": seeds,
            "note": (
                "Historical TeraGram candidates. Live Telegram discovery must revalidate current "
                "availability and relevance before use."
            ),
        }
        seed_path.write_text(json.dumps(seed_document, ensure_ascii=False, indent=2), encoding="utf-8")

        summary = {
            "generated_at": utcnow_iso(),
            "source": "teragram",
            "preview_record_id": TERAGRAM_PREVIEW_RECORD_ID,
            "latest_preview_doi": TERAGRAM_PREVIEW_LATEST_DOI,
            "full_dataset_doi": TERAGRAM_FULL_DOI,
            "signal_source": resolved_source,
            "chats_total": chats_total,
            "prefiltered_chats": prefiltered,
            "candidate_channels": candidates,
            "signal_rows_exactly_scored": signal_rows,
            "categories": category_counts,
            "seed_channels": len(seeds),
            "seed_path": str(seed_path),
            "candidate_path": str(candidate_path),
            "duckdb_path": str(database),
            "sources": sources.as_dict(),
        }
        (output / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (output / "teragram_manifest.json").write_text(
            json.dumps(
                {
                    "generated_at": summary["generated_at"],
                    "source": summary["source"],
                    "source_version": seed_document["source_version"],
                    "upstream_repository": TERAGRAM_UPSTREAM_REPOSITORY,
                    "sources": sources.as_dict(),
                    "duckdb_path": str(database),
                    "signal_source": resolved_source,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        if progress:
            progress(
                f"TeraGram: done; {candidates} candidates, {len(seeds)} seed channels, "
                f"{signal_rows} exact signal rows"
            )
        return summary
    finally:
        connection.close()
