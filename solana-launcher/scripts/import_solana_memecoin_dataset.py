#!/usr/bin/env python3
"""Import the public Solana memecoin research dataset into isolated SQLite tables.

The importer never writes token_trades, token_trade_fills, wallet_stats, inventory,
or PnL tables. All source rows are retained with source-file/row provenance.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from decimal import Decimal
from typing import Any, Iterable, Mapping

SOURCE_REPO = "ian05012/solana-memecoin-dataset"
SOURCE_COMMIT = "7070d00e1e4492f8604d988549d91785cc5f43f7"
DATASET_ID = f"{SOURCE_REPO}@{SOURCE_COMMIT}"
SOURCE_URL = f"https://github.com/{SOURCE_REPO}/tree/{SOURCE_COMMIT}"
LICENSE = "MIT"
WINDOW_START = "2026-06-10"
WINDOW_END = "2026-06-30"
EXPECTED_ROWS = {
    "tokens.parquet": 44_460,
    "ohlcv.parquet": 272_426,
    "sequences.parquet": 506_628,
    "wallets.parquet": 11_817,
    "wallet_funding.parquet": 15_493,
}
EXPECTED_TRADE_ROWS = 9_500_565
TRADE_FILES = [f"trades-{i:03d}.parquet" for i in range(4)]
REQUIRED_FILES = [
    "tokens.parquet", *TRADE_FILES, "ohlcv.parquet", "sequences.parquet",
    "wallets.parquet", "wallet_funding.parquet",
]
FILE_TABLE = {
    "tokens.parquet": "external_memecoin_tokens",
    **{name: "external_memecoin_trades" for name in TRADE_FILES},
    "ohlcv.parquet": "external_memecoin_ohlcv",
    "sequences.parquet": "external_memecoin_sequences",
    "wallets.parquet": "external_memecoin_wallets",
    "wallet_funding.parquet": "external_memecoin_wallet_funding",
}
REQUIRED_COLUMNS = {
    "tokens.parquet": {"sample_id", "token_address", "captured_at"},
    **{name: {"wallet", "token_address", "side", "amount_usd", "ts"} for name in TRADE_FILES},
    "ohlcv.parquet": {"token_address", "ts", "open", "high", "low", "close", "volume"},
    "sequences.parquet": {"sample_id", "bucket", "buy_usd", "sell_usd", "n_trades", "n_smart_buy", "n_buyers"},
    "wallets.parquet": {"address", "wallet_type"},
    "wallet_funding.parquet": {"wallet", "funder", "ts", "amount_sol"},
}
TRADE_COLUMNS = {"wallet", "token_address", "side", "amount_usd", "ts"}


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"base64": base64.b64encode(bytes(value)).decode("ascii")}
    if isinstance(value, Mapping):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if hasattr(value, "item"):
        try:
            return _json_safe(value.item())
        except Exception:
            pass
    return str(value)


def _json(value: Any) -> str:
    return json.dumps(_json_safe(value), sort_keys=True, separators=(",", ":"), allow_nan=False)


def _text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    text = str(value)
    return text if text.strip() else None


def _number(value: Any, *, nonnegative: bool = False) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(result) or (nonnegative and result < 0):
        return None
    return result


def _integer(value: Any, *, nonnegative: bool = False) -> int | None:
    number = _number(value)
    if number is None or not number.is_integer():
        return None
    result = int(number)
    if abs(result) > 9_007_199_254_740_991 or (nonnegative and result < 0):
        return None
    return result


def _epoch_seconds(value: Any) -> int | None:
    """Normalize common Unix seconds/milliseconds or ISO timestamps; retain raw value separately."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (dt.datetime, dt.date)):
        parsed = value if isinstance(value, dt.datetime) else dt.datetime.combine(value, dt.time())
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return int(parsed.timestamp())
    numeric = _number(value)
    if numeric is not None:
        # Dataset timestamps are contemporary Unix seconds; millisecond epoch
        # values are accepted explicitly. No token price/amount is inferred.
        if abs(numeric) >= 1_000_000_000_000 and abs(numeric) < 100_000_000_000_000:
            numeric /= 1000
        if abs(numeric) >= 100_000_000_000:
            return None
        return int(numeric)
    raw = str(value).strip()
    if not raw:
        return None
    try:
        numeric_text = float(raw)
        if not math.isfinite(numeric_text):
            return None
        return _epoch_seconds(numeric_text)
    except ValueError:
        pass
    try:
        parsed = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return int(parsed.timestamp())


def _flag(value: Any) -> int | None:
    if isinstance(value, bool):
        return int(value)
    if value in (0, 1, "0", "1"):
        return int(value)
    if isinstance(value, str) and value.strip().lower() in {"true", "false"}:
        return int(value.strip().lower() == "true")
    return None


SCHEMA = """
CREATE TABLE IF NOT EXISTS external_memecoin_dataset_catalog (
  dataset_id TEXT PRIMARY KEY,
  source_repo TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  source_url TEXT NOT NULL,
  license TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('importing','complete')),
  expected_rows INTEGER NOT NULL,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  manifest_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS external_memecoin_import_files (
  dataset_id TEXT NOT NULL,
  source_file TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
  source_rows INTEGER NOT NULL,
  imported_rows INTEGER NOT NULL,
  incomplete_rows INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('complete')),
  imported_at INTEGER NOT NULL,
  PRIMARY KEY(dataset_id,source_file)
);
CREATE TABLE IF NOT EXISTS external_memecoin_tokens (
  dataset_id TEXT NOT NULL, source_file TEXT NOT NULL, source_row INTEGER NOT NULL,
  sample_id TEXT, token_address TEXT, symbol TEXT, pool_address TEXT,
  captured_at_raw TEXT, captured_at_epoch INTEGER, time_since_launch_sec INTEGER,
  price_at_capture REAL, market_cap_usd REAL, liquidity_usd REAL, volume_h24 REAL,
  max_return_1h REAL, max_return_6h REAL, max_return_24h REAL, max_return_3d REAL,
  reaches_2x INTEGER, runner_peak_x REAL, staged_exit_return REAL, scalp_exit_return REAL,
  close_return_1h REAL, mdd_from_peak REAL, time_to_peak_sec INTEGER,
  raw_json TEXT NOT NULL,
  PRIMARY KEY(dataset_id,source_file,source_row)
);
CREATE TABLE IF NOT EXISTS external_memecoin_trades (
  dataset_id TEXT NOT NULL, source_file TEXT NOT NULL, source_row INTEGER NOT NULL,
  wallet TEXT, token_address TEXT, side TEXT, side_raw TEXT,
  amount_usd REAL, amount_usd_raw TEXT, ts_epoch INTEGER, ts_raw TEXT,
  extra_json TEXT, quality_status TEXT NOT NULL,
  quality_reasons_json TEXT NOT NULL,
  PRIMARY KEY(dataset_id,source_file,source_row)
);
CREATE TABLE IF NOT EXISTS external_memecoin_ohlcv (
  dataset_id TEXT NOT NULL, source_file TEXT NOT NULL, source_row INTEGER NOT NULL,
  token_address TEXT, ts_epoch INTEGER, ts_raw TEXT,
  open REAL, high REAL, low REAL, close REAL, volume REAL, raw_json TEXT NOT NULL,
  PRIMARY KEY(dataset_id,source_file,source_row)
);
CREATE TABLE IF NOT EXISTS external_memecoin_sequences (
  dataset_id TEXT NOT NULL, source_file TEXT NOT NULL, source_row INTEGER NOT NULL,
  sample_id TEXT, bucket INTEGER, buy_usd REAL, sell_usd REAL,
  n_trades INTEGER, n_smart_buy INTEGER, n_buyers INTEGER, raw_json TEXT NOT NULL,
  PRIMARY KEY(dataset_id,source_file,source_row)
);
CREATE TABLE IF NOT EXISTS external_memecoin_wallets (
  dataset_id TEXT NOT NULL, source_file TEXT NOT NULL, source_row INTEGER NOT NULL,
  address TEXT, wallet_type TEXT, labels TEXT, win_rate REAL, avg_pnl_ratio REAL,
  trade_count_90d INTEGER, avg_holding_hours REAL, pagerank REAL, cluster_id TEXT,
  raw_json TEXT NOT NULL,
  PRIMARY KEY(dataset_id,source_file,source_row)
);
CREATE TABLE IF NOT EXISTS external_memecoin_wallet_funding (
  dataset_id TEXT NOT NULL, source_file TEXT NOT NULL, source_row INTEGER NOT NULL,
  wallet TEXT, funder TEXT, ts_epoch INTEGER, ts_raw TEXT, amount_sol REAL,
  raw_json TEXT NOT NULL,
  PRIMARY KEY(dataset_id,source_file,source_row)
);
"""


INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_ext_memecoin_tokens_address_time ON external_memecoin_tokens(dataset_id,token_address,captured_at_epoch)",
    "CREATE INDEX IF NOT EXISTS idx_ext_memecoin_tokens_sample ON external_memecoin_tokens(dataset_id,sample_id)",
    "CREATE INDEX IF NOT EXISTS idx_ext_memecoin_trades_token_time ON external_memecoin_trades(dataset_id,token_address,ts_epoch)",
    "CREATE INDEX IF NOT EXISTS idx_ext_memecoin_trades_wallet_time ON external_memecoin_trades(dataset_id,wallet,ts_epoch)",
    "CREATE INDEX IF NOT EXISTS idx_ext_memecoin_trades_side_time ON external_memecoin_trades(dataset_id,side,ts_epoch)",
    "CREATE INDEX IF NOT EXISTS idx_ext_memecoin_ohlcv_token_time ON external_memecoin_ohlcv(dataset_id,token_address,ts_epoch)",
    "CREATE INDEX IF NOT EXISTS idx_ext_memecoin_sequences_sample ON external_memecoin_sequences(dataset_id,sample_id,bucket)",
    "CREATE INDEX IF NOT EXISTS idx_ext_memecoin_wallets_address ON external_memecoin_wallets(dataset_id,address)",
    "CREATE INDEX IF NOT EXISTS idx_ext_memecoin_wallets_type ON external_memecoin_wallets(dataset_id,wallet_type)",
    "CREATE INDEX IF NOT EXISTS idx_ext_memecoin_funding_wallet_time ON external_memecoin_wallet_funding(dataset_id,wallet,ts_epoch)",
    "CREATE INDEX IF NOT EXISTS idx_ext_memecoin_funding_funder_time ON external_memecoin_wallet_funding(dataset_id,funder,ts_epoch)",
]


INSERTS = {
    "tokens.parquet": (
        "INSERT INTO external_memecoin_tokens VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        lambda d, f, i, r: (
            d, f, i, _text(r.get("sample_id")), _text(r.get("token_address")),
            _text(r.get("symbol")), _text(r.get("pool_address")),
            _text(r.get("captured_at")), _epoch_seconds(r.get("captured_at")),
            _integer(r.get("time_since_launch_sec"), nonnegative=True),
            _number(r.get("price_at_capture"), nonnegative=True),
            _number(r.get("market_cap_usd"), nonnegative=True),
            _number(r.get("liquidity_usd"), nonnegative=True),
            _number(r.get("volume_h24"), nonnegative=True),
            _number(r.get("max_return_1h"), nonnegative=True),
            _number(r.get("max_return_6h"), nonnegative=True),
            _number(r.get("max_return_24h"), nonnegative=True),
            _number(r.get("max_return_3d"), nonnegative=True),
            _flag(r.get("reaches_2x")), _number(r.get("runner_peak_x"), nonnegative=True),
            _number(r.get("staged_exit_return")), _number(r.get("scalp_exit_return")),
            _number(r.get("close_return_1h")), _number(r.get("mdd_from_peak")),
            _integer(r.get("time_to_peak_sec"), nonnegative=True), _json(r),
        ),
    ),
    "trades-000.parquet": (
        "INSERT INTO external_memecoin_trades VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        None,
    ),
    "trades-001.parquet": ("INSERT INTO external_memecoin_trades VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", None),
    "trades-002.parquet": ("INSERT INTO external_memecoin_trades VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", None),
    "trades-003.parquet": ("INSERT INTO external_memecoin_trades VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", None),
    "ohlcv.parquet": (
        "INSERT INTO external_memecoin_ohlcv VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        lambda d, f, i, r: (
            d, f, i, _text(r.get("token_address")), _epoch_seconds(r.get("ts")),
            _text(r.get("ts")), _number(r.get("open")), _number(r.get("high")),
            _number(r.get("low")), _number(r.get("close")), _number(r.get("volume"), nonnegative=True), _json(r),
        ),
    ),
    "sequences.parquet": (
        "INSERT INTO external_memecoin_sequences VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        lambda d, f, i, r: (
            d, f, i, _text(r.get("sample_id")), _integer(r.get("bucket"), nonnegative=True),
            _number(r.get("buy_usd"), nonnegative=True), _number(r.get("sell_usd"), nonnegative=True),
            _integer(r.get("n_trades"), nonnegative=True), _integer(r.get("n_smart_buy"), nonnegative=True),
            _integer(r.get("n_buyers"), nonnegative=True), _json(r),
        ),
    ),
    "wallets.parquet": (
        "INSERT INTO external_memecoin_wallets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        lambda d, f, i, r: (
            d, f, i, _text(r.get("address")), _text(r.get("wallet_type")), _text(r.get("labels")),
            _number(r.get("win_rate")), _number(r.get("avg_pnl_ratio")),
            _integer(r.get("trade_count_90d"), nonnegative=True), _number(r.get("avg_holding_hours"), nonnegative=True),
            _number(r.get("pagerank"), nonnegative=True), _text(r.get("cluster_id")), _json(r),
        ),
    ),
    "wallet_funding.parquet": (
        "INSERT INTO external_memecoin_wallet_funding VALUES (?,?,?,?,?,?,?,?,?)",
        lambda d, f, i, r: (
            d, f, i, _text(r.get("wallet")), _text(r.get("funder")),
            _epoch_seconds(r.get("ts")), _text(r.get("ts")),
            _number(r.get("amount_sol"), nonnegative=True), _json(r),
        ),
    ),
}


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)


def _trade_values(dataset_id: str, source_file: str, source_row: int, row: Mapping[str, Any]) -> tuple[Any, ...]:
    wallet = _text(row.get("wallet"))
    token_address = _text(row.get("token_address"))
    side_raw = _text(row.get("side"))
    side = side_raw.lower() if side_raw and side_raw.lower() in {"buy", "sell"} else None
    amount = _number(row.get("amount_usd"), nonnegative=True)
    ts_epoch = _epoch_seconds(row.get("ts"))
    reasons = []
    if wallet is None:
        reasons.append("missing_wallet")
    if token_address is None:
        reasons.append("missing_token_address")
    if side is None:
        reasons.append("invalid_side")
    if amount is None:
        reasons.append("invalid_amount_usd")
    if ts_epoch is None:
        reasons.append("invalid_timestamp")
    extra = {k: v for k, v in row.items() if k not in TRADE_COLUMNS}
    return (
        dataset_id, source_file, source_row, wallet, token_address, side, side_raw,
        amount, _text(row.get("amount_usd")), ts_epoch, _text(row.get("ts")),
        _json(extra) if extra else None, "valid" if not reasons else "incomplete", _json(reasons),
    )


def normalize_row(source_file: str, dataset_id: str, row_index: int, row: Mapping[str, Any]) -> tuple[Any, ...]:
    if source_file.startswith("trades-") and source_file.endswith(".parquet"):
        return _trade_values(dataset_id, source_file, row_index, row)
    if source_file not in INSERTS or INSERTS[source_file][1] is None:
        raise ValueError(f"Unsupported dataset file: {source_file}")
    return INSERTS[source_file][1](dataset_id, source_file, row_index, row)


def import_file_rows(
    conn: sqlite3.Connection,
    dataset_id: str,
    source_file: str,
    rows: Iterable[Mapping[str, Any]],
    source_sha256: str,
    source_rows: int,
    imported_at: int,
) -> dict[str, Any]:
    """Import/re-import one source file atomically; source-row IDs preserve partial fills."""
    if source_file not in FILE_TABLE:
        raise ValueError(f"Unsupported dataset file: {source_file}")
    if len(source_sha256) != 64 or any(c not in "0123456789abcdef" for c in source_sha256.lower()):
        raise ValueError("source_sha256 must be a 64-character hex digest")
    if source_rows < 0:
        raise ValueError("source_rows must be non-negative")
    previous = conn.execute(
        "SELECT source_sha256,source_rows,imported_rows,status,incomplete_rows FROM external_memecoin_import_files WHERE dataset_id=? AND source_file=?",
        (dataset_id, source_file),
    ).fetchone()
    if previous and previous[0] == source_sha256 and previous[1] == source_rows and previous[2] == source_rows and previous[3] == "complete":
        return {"source_file": source_file, "source_rows": source_rows, "imported_rows": source_rows,
                "incomplete_rows": int(previous[4]), "status": "skipped_unchanged"}
    table = FILE_TABLE[source_file]
    insert_sql = INSERTS[source_file][0]
    inserted = 0
    incomplete = 0
    batch: list[tuple[Any, ...]] = []
    batch_size = 10_000
    with conn:
        conn.execute(f"DELETE FROM {table} WHERE dataset_id=? AND source_file=?", (dataset_id, source_file))
        for row_index, row in enumerate(rows):
            if not isinstance(row, Mapping):
                raise ValueError(f"{source_file} row {row_index} is not an object")
            values = normalize_row(source_file, dataset_id, row_index, row)
            batch.append(values)
            if source_file.startswith("trades-") and values[-2] != "valid":
                incomplete += 1
            if len(batch) >= batch_size:
                conn.executemany(insert_sql, batch)
                inserted += len(batch)
                batch.clear()
        if batch:
            conn.executemany(insert_sql, batch)
            inserted += len(batch)
        if inserted != source_rows:
            raise ValueError(f"{source_file}: metadata says {source_rows} rows but reader yielded {inserted}; transaction rolled back")
        conn.execute(
            """INSERT INTO external_memecoin_import_files
               (dataset_id,source_file,source_sha256,source_rows,imported_rows,incomplete_rows,status,imported_at)
               VALUES(?,?,?,?,?,?, 'complete',?)
               ON CONFLICT(dataset_id,source_file) DO UPDATE SET
                 source_sha256=excluded.source_sha256,source_rows=excluded.source_rows,
                 imported_rows=excluded.imported_rows,incomplete_rows=excluded.incomplete_rows,
                 status='complete',imported_at=excluded.imported_at""",
            (dataset_id, source_file, source_sha256.lower(), source_rows, inserted, incomplete, imported_at),
        )
    return {"source_file": source_file, "source_rows": source_rows, "imported_rows": inserted,
            "incomplete_rows": incomplete, "status": "imported"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parquet_info(path: Path) -> dict[str, Any]:
    try:
        import pyarrow.parquet as pq
    except ImportError as exc:
        raise RuntimeError("Parquet support requires pyarrow. Install it with: python -m pip install pyarrow") from exc
    parquet = pq.ParquetFile(path)
    return {"rows": parquet.metadata.num_rows, "columns": set(parquet.schema_arrow.names),
            "sha256": sha256_file(path), "path": path}


def iter_parquet_rows(path: Path, batch_size: int = 10_000) -> Iterable[Mapping[str, Any]]:
    try:
        import pyarrow.parquet as pq
    except ImportError as exc:
        raise RuntimeError("Parquet support requires pyarrow. Install it with: python -m pip install pyarrow") from exc
    parquet = pq.ParquetFile(path)
    for batch in parquet.iter_batches(batch_size=batch_size, use_threads=True):
        yield from batch.to_pylist()


def verify_source_revision(source_dir: Path) -> str:
    repo_root = source_dir.parent
    if not (repo_root / ".git").exists():
        raise ValueError("Source must be a Git checkout with its data/ directory; clone the repository and checkout the pinned commit")
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_root), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ValueError(f"Unable to verify dataset Git revision: {exc}") from exc
    actual = result.stdout.strip()
    if actual != SOURCE_COMMIT:
        raise ValueError(f"Dataset revision mismatch: expected {SOURCE_COMMIT}, found {actual}; checkout the pinned revision before importing")
    return actual


def preflight(source_dir: Path, allow_count_mismatch: bool = False) -> list[dict[str, Any]]:
    missing = [name for name in REQUIRED_FILES if not (source_dir / name).is_file()]
    if missing:
        raise FileNotFoundError("Missing required Parquet files: " + ", ".join(missing))
    result = []
    for name in REQUIRED_FILES:
        info = parquet_info(source_dir / name)
        missing_columns = REQUIRED_COLUMNS[name] - info["columns"]
        if missing_columns:
            raise ValueError(f"{name}: required columns absent: {', '.join(sorted(missing_columns))}")
        result.append({"source_file": name, **info})
    observed = {item["source_file"]: item["rows"] for item in result}
    mismatches = []
    for name, expected in EXPECTED_ROWS.items():
        if observed[name] != expected:
            mismatches.append(f"{name}: expected {expected}, found {observed[name]}")
    trades_total = sum(observed[name] for name in TRADE_FILES)
    if trades_total != EXPECTED_TRADE_ROWS:
        mismatches.append(f"trades total: expected {EXPECTED_TRADE_ROWS}, found {trades_total}")
    if mismatches and not allow_count_mismatch:
        raise ValueError("Dataset row counts differ from the pinned README; use --allow-count-mismatch only after reviewing: " + "; ".join(mismatches))
    return result


def backup_database(db_path: Path, backup_path: Path) -> None:
    if not db_path.exists():
        return
    if backup_path.exists():
        raise FileExistsError(f"Backup already exists; choose a new path: {backup_path}")
    if db_path.resolve() == backup_path.resolve():
        raise ValueError("Backup path must differ from database path")
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(str(db_path), timeout=30)
    target = sqlite3.connect(str(backup_path), timeout=30)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()


def canonical_counts(conn: sqlite3.Connection) -> dict[str, int]:
    counts = {}
    for table in ("token_trades", "token_trade_fills", "wallet_stats", "wallet_token_stats"):
        exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
        if exists:
            counts[table] = int(conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0])
    return counts


def _connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def run_import(source_dir: Path, db_path: Path, files: list[dict[str, Any]], backup_path: Path | None = None) -> dict[str, Any]:
    if db_path.exists():
        if backup_path is None:
            raise ValueError("Existing database requires --backup-path before --apply")
        backup_database(db_path, backup_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = _connect(db_path)
    now = int(dt.datetime.now(dt.timezone.utc).timestamp())
    before = canonical_counts(conn)
    file_reports = []
    try:
        ensure_schema(conn)
        manifest = {item["source_file"]: {"rows": item["rows"], "sha256": item["sha256"]} for item in files}
        expected_total = sum(item["rows"] for item in files)
        with conn:
            conn.execute(
                """INSERT INTO external_memecoin_dataset_catalog
                   (dataset_id,source_repo,source_commit,source_url,license,window_start,window_end,
                    status,expected_rows,imported_rows,manifest_json,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,'importing',?,0,?,?,?)
                   ON CONFLICT(dataset_id) DO UPDATE SET status='importing',
                    expected_rows=excluded.expected_rows,manifest_json=excluded.manifest_json,updated_at=excluded.updated_at""",
                (DATASET_ID,SOURCE_REPO,SOURCE_COMMIT,SOURCE_URL,LICENSE,WINDOW_START,WINDOW_END,
                 expected_total,_json(manifest),now,now),
            )
        for item in files:
            report = import_file_rows(
                conn, DATASET_ID, item["source_file"], iter_parquet_rows(item["path"]),
                item["sha256"], item["rows"], int(dt.datetime.now(dt.timezone.utc).timestamp()),
            )
            file_reports.append(report)
            print(json.dumps({"file": report}, ensure_ascii=False), flush=True)
        create_indexes(conn)
        totals = conn.execute(
            "SELECT COALESCE(sum(imported_rows),0),COALESCE(sum(incomplete_rows),0) FROM external_memecoin_import_files WHERE dataset_id=?",
            (DATASET_ID,),
        ).fetchone()
        completed = conn.execute(
            "SELECT count(*) FROM external_memecoin_import_files WHERE dataset_id=? AND status='complete'",
            (DATASET_ID,),
        ).fetchone()[0]
        if completed != len(REQUIRED_FILES):
            raise RuntimeError(f"Dataset incomplete: {completed}/{len(REQUIRED_FILES)} source files imported")
        with conn:
            conn.execute(
                "UPDATE external_memecoin_dataset_catalog SET status='complete',imported_rows=?,manifest_json=?,updated_at=? WHERE dataset_id=?",
                (int(totals[0]),_json({"files": manifest, "file_reports": file_reports,
                    "incomplete_trade_rows": int(totals[1])}),int(dt.datetime.now(dt.timezone.utc).timestamp()),DATASET_ID),
            )
        after = canonical_counts(conn)
        if before != after:
            raise RuntimeError(f"Canonical trade/PnL tables changed unexpectedly: before={before}, after={after}")
        return {"status":"complete","dataset_id":DATASET_ID,"source_files":len(file_reports),
            "source_rows":expected_total,"imported_rows":int(totals[0]),
            "incomplete_trade_rows":int(totals[1]),"canonical_table_counts_unchanged":True,
            "backup_path":str(backup_path) if backup_path else None,"files":file_reports}
    finally:
        conn.close()


def create_indexes(conn: sqlite3.Connection) -> None:
    with conn:
        for statement in INDEXES:
            conn.execute(statement)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", required=True, help="Absolute or relative path to the dataset's data/ folder containing all Parquet files")
    parser.add_argument("--db", required=True, help="Explicit path to the existing or new SQLite trade.db")
    parser.add_argument("--apply", action="store_true", help="Write rows; without this flag the command is a read-only preflight")
    parser.add_argument("--backup-path", help="Required for an existing DB when --apply is set; SQLite online backup destination")
    parser.add_argument("--allow-count-mismatch", action="store_true", help="Import a different dataset revision only after reviewing the source manifest")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    source_dir = Path(args.source_dir).expanduser().resolve()
    db_path = Path(args.db).expanduser().resolve()
    backup_path = Path(args.backup_path).expanduser().resolve() if args.backup_path else None
    if not source_dir.is_dir():
        raise FileNotFoundError(f"Source directory does not exist: {source_dir}")
    if db_path.is_dir():
        raise IsADirectoryError(f"--db must be a SQLite file path, not a directory: {db_path}")
    if backup_path and backup_path == db_path:
        raise ValueError("--backup-path must differ from --db")
    verified_commit = verify_source_revision(source_dir)
    files = preflight(source_dir, allow_count_mismatch=args.allow_count_mismatch)
    report = {"mode":"apply" if args.apply else "dry_run","dataset_id":DATASET_ID,
        "source_commit_verified":verified_commit,"source_dir":str(source_dir),"db":str(db_path),
        "source_rows":sum(item["rows"] for item in files),
        "files":[{"source_file":item["source_file"],"rows":item["rows"],"sha256":item["sha256"]} for item in files]}
    if not args.apply:
        print(json.dumps(report,ensure_ascii=False,indent=2))
        return 0
    result = run_import(source_dir,db_path,files,backup_path=backup_path)
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"dataset import failed: {exc}",file=sys.stderr)
        raise SystemExit(1)
