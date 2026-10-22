"""Stage public Telegram channel datasets in the existing collector registry."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.telegram_dataset_sources import (
    iter_local_dataset_channels,
    sync_public_dataset_channels,
)
from app.services.telegram_discovery_registry import import_dataset_channel_candidates

TGDATASET_URL = "https://github.com/SystemsLab-Sapienza/TGDataset"
TGDATASET_LICENSE = "See https://zenodo.org/records/7640712 and cite the TGDataset paper"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Import public channel metadata into the Telegram Collector candidate queue"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("sync-public", help="Fetch the configured small public channel datasets")
    local = subparsers.add_parser(
        "import-local", help="Import channel metadata from local CSV/JSON or TGDataset files"
    )
    local.add_argument(
        "path",
        type=Path,
        nargs="?",
        help="CSV/JSON file or dataset directory (defaults to TG_DATASET_LOCAL_PATH)",
    )
    local.add_argument("--limit", type=int, default=1000, help="Maximum channels; 0 means no cap")
    local.add_argument("--source-name", default="tgdataset-local", help="Provenance label")
    local.add_argument(
        "--topics",
        default="",
        help="Comma-separated topic labels; use all to disable TGDataset's default Crypto filter",
    )
    local.add_argument("--source-url", default="", help="Dataset landing page for provenance")
    local.add_argument("--license", default="", help="Dataset license label for provenance")
    local.add_argument(
        "--dry-run", action="store_true", help="Count candidate rows without DB writes"
    )
    return parser


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    try:
        if args.command == "sync-public":
            return await sync_public_dataset_channels(sessionmaker, settings)

        if args.limit < 0:
            raise ValueError("--limit must be zero (unlimited) or a positive integer")
        local_path = args.path or Path(settings.telegram_dataset_local_path)
        topics = {value.strip() for value in args.topics.split(",") if value.strip()}
        records = iter_local_dataset_channels(
            local_path,
            limit=args.limit,
            source_name=args.source_name,
            topics=topics or None,
        )
        if args.dry_run:
            received = accepted = scam_skipped = 0
            for row in records:
                received += 1
                if str(row.get("scam", "")).strip().casefold() in {"1", "true", "yes"}:
                    scam_skipped += 1
                elif row.get("username"):
                    accepted += 1
            return {
                "dry_run": True,
                "source": args.source_name,
                "received": received,
                "candidate_rows": accepted,
                "scam_marked": scam_skipped,
            }

        stats = await import_dataset_channel_candidates(
            sessionmaker,
            records,
            source_name=args.source_name,
            source_url=args.source_url
            or (TGDATASET_URL if args.source_name == "tgdataset-local" else ""),
            source_license=args.license
            or (TGDATASET_LICENSE if args.source_name == "tgdataset-local" else ""),
            batch_size=250,
        )
        return {"source": args.source_name, **stats}
    finally:
        await engine.dispose()


def main() -> None:
    args = _parser().parse_args()
    result = asyncio.run(_run(args))
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
