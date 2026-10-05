from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.services.teragram_scanner import scan_teragram_dataset


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Filter the TeraGram Telegram dataset from local CSV/Parquet files. DuckDB performs "
            "the multi-terabyte prefilter out of core; only crypto-relevant signal rows are sent "
            "through the existing POTAPoff Telegram parser/scoring logic."
        )
    )
    parser.add_argument(
        "--input-dir",
        required=True,
        help=(
            "TeraGram root containing chats/messages tables. Supports preview CSV files and full "
            "Parquet layout such as messages/messages_batch_00.parquet."
        ),
    )
    parser.add_argument(
        "--output",
        default="data/teragram",
        help="output directory for candidates, seed database and DuckDB state",
    )
    parser.add_argument(
        "--seed-limit",
        type=int,
        default=250,
        help="maximum historical candidates written to telegram_seed_database.json",
    )
    parser.add_argument(
        "--max-chats",
        type=int,
        default=None,
        help="development/testing limit after the cheap candidate prefilter",
    )
    parser.add_argument(
        "--recent-messages-per-chat",
        type=int,
        default=100,
        help="score only the newest N messages per chat (default: 100)",
    )
    parser.add_argument(
        "--signal-source",
        choices=("auto", "content", "entities", "metadata"),
        default="auto",
        help=(
            "auto prefers message_content when available, otherwise URL/hashtag entities; "
            "metadata scans only chat name/title/description"
        ),
    )
    parser.add_argument(
        "--database",
        default=None,
        help="optional DuckDB state path (default: <output>/teragram.duckdb)",
    )
    parser.add_argument(
        "--temp-dir",
        default=None,
        help="DuckDB spill directory (default: <output>/duckdb_tmp)",
    )
    parser.add_argument(
        "--threads",
        type=int,
        default=None,
        help="DuckDB worker threads; default lets DuckDB choose",
    )
    parser.add_argument(
        "--memory-limit",
        default="4GB",
        help="DuckDB memory ceiling such as 2GB, 8GB or 64GB (default: 4GB)",
    )
    parser.add_argument(
        "--fetch-size",
        type=int,
        default=10_000,
        help="number of prefiltered rows fetched into Python per batch (default: 10000)",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.seed_limit < 1:
        parser.error("--seed-limit must be positive")
    if args.max_chats is not None and args.max_chats < 1:
        parser.error("--max-chats must be positive")
    if args.recent_messages_per_chat < 1:
        parser.error("--recent-messages-per-chat must be positive")
    if args.threads is not None and args.threads < 1:
        parser.error("--threads must be positive")
    if args.fetch_size < 1:
        parser.error("--fetch-size must be positive")

    output = Path(args.output)
    summary = scan_teragram_dataset(
        input_dir=args.input_dir,
        output_dir=output,
        seed_limit=args.seed_limit,
        max_chats=args.max_chats,
        recent_messages_per_chat=args.recent_messages_per_chat,
        signal_source=args.signal_source,
        duckdb_path=args.database,
        threads=args.threads,
        memory_limit=args.memory_limit,
        temp_dir=args.temp_dir,
        fetch_size=args.fetch_size,
        progress=lambda line: print(line, flush=True),
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    print(f"Seed database: {output / 'telegram_seed_database.json'}", flush=True)


if __name__ == "__main__":
    main()
