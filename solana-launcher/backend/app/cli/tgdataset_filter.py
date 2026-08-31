from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.services.tgdataset_scanner import scan_archives


def _archive_numbers(value: str) -> list[int]:
    result: list[int] = []
    for item in (value or "").split(","):
        item = item.strip()
        if not item:
            continue
        try:
            number = int(item)
        except ValueError as exc:
            raise argparse.ArgumentTypeError("--archives must contain comma-separated numbers 1..4") from exc
        if number not in {1, 2, 3, 4}:
            raise argparse.ArgumentTypeError("--archives values must be between 1 and 4")
        if number not in result:
            result.append(number)
    if not result:
        raise argparse.ArgumentTypeError("at least one archive is required")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Stream TGDataset from Zenodo (or local tar.gz files), classify crypto/memecoin/"
            "Solana/caller channels and emit a small Telegram seed database."
        )
    )
    parser.add_argument(
        "--source",
        choices=("zenodo", "local"),
        default="zenodo",
        help="zenodo streams archives without saving them; local reads an existing directory",
    )
    parser.add_argument(
        "--input-dir",
        default=None,
        help="directory containing TGDataset_1.tar.gz ... TGDataset_4.tar.gz for --source local",
    )
    parser.add_argument(
        "--output",
        default="data/tgdataset",
        help="small output/checkpoint directory (default: data/tgdataset)",
    )
    parser.add_argument(
        "--archives",
        type=_archive_numbers,
        default=[1, 2, 3, 4],
        help="comma-separated archive numbers, e.g. 1 or 1,2,3,4",
    )
    parser.add_argument(
        "--seed-limit",
        type=int,
        default=250,
        help="maximum historical candidates written to telegram_seed_database.json",
    )
    parser.add_argument(
        "--max-channels",
        type=int,
        default=None,
        help="development/testing limit per archive; omit for the full dataset",
    )
    parser.add_argument(
        "--no-resume",
        action="store_true",
        help="reprocess archives even when archive-level checkpoints already exist",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.source == "local" and not args.input_dir:
        parser.error("--input-dir is required when --source local")
    if args.seed_limit < 1:
        parser.error("--seed-limit must be positive")
    if args.max_channels is not None and args.max_channels < 1:
        parser.error("--max-channels must be positive")

    output = Path(args.output)
    summary = scan_archives(
        output_dir=output,
        archive_numbers=args.archives,
        local_dir=args.input_dir if args.source == "local" else None,
        resume=not args.no_resume,
        seed_limit=args.seed_limit,
        max_channels=args.max_channels,
        progress=lambda line: print(line, flush=True),
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    print(f"Seed database: {output / 'telegram_seed_database.json'}", flush=True)


if __name__ == "__main__":
    main()
