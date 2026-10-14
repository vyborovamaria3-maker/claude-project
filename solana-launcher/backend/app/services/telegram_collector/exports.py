"""Telegram Collector: deterministic JSON, safe CSV, optional Parquet export."""

from __future__ import annotations

import csv
import io
import json
from typing import Any, Literal

FORMAT = Literal["json", "csv", "parquet"]
FIELDS = (
    "message_id",
    "channel_id",
    "sender",
    "published_at",
    "text",
    "views",
    "forwards",
    "replies",
    "reactions",
)


def _cell(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    # CSV formula injection protection for downstream spreadsheet viewers.
    if text.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + text
    return text


def encode_messages(
    records: list[dict[str, Any]], format: FORMAT
) -> tuple[bytes, str, str]:
    """Serialize normalized message rows with predictable columns."""
    normalized = [{field: row.get(field) for field in FIELDS} for row in records]
    if format == "json":
        return (
            json.dumps(normalized, ensure_ascii=False, default=str, indent=2).encode("utf-8"),
            "application/json",
            "json",
        )
    if format == "csv":
        output = io.StringIO(newline="")
        writer = csv.DictWriter(output, fieldnames=FIELDS)
        writer.writeheader()
        for row in normalized:
            writer.writerow({key: _cell(value) for key, value in row.items()})
        return output.getvalue().encode("utf-8-sig"), "text/csv", "csv"
    if format == "parquet":
        try:
            import pyarrow as pa
            import pyarrow.parquet as pq
        except ImportError as exc:
            raise RuntimeError(
                "Parquet export is unavailable: install the backend parquet extra"
            ) from exc
        table = pa.Table.from_pylist(normalized) if normalized else pa.table(
            {field: pa.array([], type=pa.string()) for field in FIELDS}
        )
        buffer = io.BytesIO()
        pq.write_table(table, buffer, compression="zstd")
        return buffer.getvalue(), "application/vnd.apache.parquet", "parquet"
    raise ValueError("Unsupported Telegram export format")
