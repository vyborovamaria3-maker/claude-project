"""Import local tgparser-cli archive files without Telegram network access."""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
from pathlib import Path

from app.db.session import create_engine_and_sessionmaker
from app.services.telegram_collector.tgparser_import import MAX_BATCH, import_tgparser_archive

MAX_ARCHIVE_BYTES = 20 * 1024 * 1024


def read_archive(path: Path) -> list[dict]:
    if not path.is_file():
        raise ValueError("Archive file not found")
    if path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Archive exceeds 20 MiB; split into smaller files")
    suffix = path.suffix.lower()
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        if suffix == ".csv":
            return list(csv.DictReader(source))
        if suffix == ".json":
            parsed = json.load(source)
            if not isinstance(parsed, list) or not all(isinstance(x, dict) for x in parsed):
                raise ValueError("Expected a list of tgparser-cli JSON messages")
            return parsed
    raise ValueError("Only tgparser-cli .json and .csv archives are supported")


async def run(path: Path, channel_id: int) -> None:
    records = read_archive(path)
    if not records:
        raise ValueError("Archive contains no messages")
    engine, sessionmaker = create_engine_and_sessionmaker()
    added = duplicates = 0
    try:
        async with sessionmaker() as session:
            for offset in range(0, len(records), MAX_BATCH):
                stats = await import_tgparser_archive(
                    session,
                    channel_id=channel_id,
                    records=records[offset : offset + MAX_BATCH],
                )
                await session.commit()
                added += stats["inserted"]
                duplicates += stats["duplicates"]
    finally:
        await engine.dispose()
    print(f"Imported {added} messages; skipped {duplicates} duplicates.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Import a trusted local tgparser-cli archive")
    parser.add_argument("archive", type=Path, help="Exported .json or .csv file")
    parser.add_argument("--channel-id", type=int, required=True, help="Existing DB channel id")
    args = parser.parse_args()
    asyncio.run(run(args.archive, args.channel_id))


if __name__ == "__main__":
    main()
