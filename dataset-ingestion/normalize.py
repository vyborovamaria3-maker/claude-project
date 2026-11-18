"""Source-specific, research-only normalized projections from authorized offline staging."""
from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

PROJECTION_VERSION = "source-projection-v1"
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
BASE58_INDEX = {char: i for i, char in enumerate(ALPHABET)}
SCHEMA = """
CREATE TABLE IF NOT EXISTS token_metadata_projections (
 dataset_id TEXT NOT NULL, file_sha256 TEXT NOT NULL, member TEXT NOT NULL,
 row_number INTEGER NOT NULL, projection_version TEXT NOT NULL,
 mint_candidate TEXT NOT NULL,
 token_name TEXT, token_ticker TEXT, description TEXT,
 source_created_raw TEXT, source_time_precision TEXT NOT NULL,
 first_system_available_at TEXT NOT NULL, rights_evidence TEXT NOT NULL,
 mint_verified INTEGER NOT NULL DEFAULT 0 CHECK(mint_verified=0),
 PRIMARY KEY(dataset_id,file_sha256,member,row_number,projection_version)
);
CREATE INDEX IF NOT EXISTS idx_token_metadata_mint_candidate
  ON token_metadata_projections(mint_candidate);
CREATE TABLE IF NOT EXISTS token_outcomes_research_only (
 dataset_id TEXT NOT NULL, file_sha256 TEXT NOT NULL, member TEXT NOT NULL,
 row_number INTEGER NOT NULL, projection_version TEXT NOT NULL,
 mint_candidate TEXT NOT NULL,
 market_cap_snapshot_raw TEXT, bonding_complete_time_raw TEXT,
 -- Outcomes must not be queried as of the creation timestamp; actual availability is unknown.
 available_at TEXT NOT NULL, time_precision TEXT NOT NULL DEFAULT 'unknown',
 PRIMARY KEY(dataset_id,file_sha256,member,row_number,projection_version)
);
CREATE TABLE IF NOT EXISTS token_social_link_projections (
 dataset_id TEXT NOT NULL, file_sha256 TEXT NOT NULL, member TEXT NOT NULL,
 row_number INTEGER NOT NULL, projection_version TEXT NOT NULL,
 mint_candidate TEXT NOT NULL, source_platform TEXT NOT NULL,
 website TEXT, twitter TEXT, telegram TEXT, discord TEXT,
 first_system_available_at TEXT NOT NULL, rights_evidence TEXT NOT NULL,
 mint_verified INTEGER NOT NULL DEFAULT 0 CHECK(mint_verified=0),
 PRIMARY KEY(dataset_id,file_sha256,member,row_number,projection_version)
);
CREATE INDEX IF NOT EXISTS idx_token_social_mint_candidate
  ON token_social_link_projections(mint_candidate);
CREATE TABLE IF NOT EXISTS dataset_projection_runs (
 run_id INTEGER PRIMARY KEY AUTOINCREMENT,
 dataset_id TEXT NOT NULL, projection_version TEXT NOT NULL,
 started_at TEXT NOT NULL, completed_at TEXT,
 processed INTEGER NOT NULL DEFAULT 0, inserted INTEGER NOT NULL DEFAULT 0,
 skipped INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL CHECK(status IN ('running','completed','failed'))
);
"""


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def valid_solana_pubkey(value: str) -> bool:
    """Exact 32-byte Solana public-key syntax only. Never interpreted as an SPL mint proof."""
    if not isinstance(value, str) or len(value) < 32 or len(value) > 44:
        return False
    number = 0
    for char in value:
        digit = BASE58_INDEX.get(char)
        if digit is None:
            return False
        number = number * 58 + digit
    prefix_zeros = len(value) - len(value.lstrip("1"))
    size = (number.bit_length() + 7) // 8
    return prefix_zeros + size == 32


def normalized_url(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value:
        return None
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    # Never fetch these URLs or treat them as authenticated; preserve only valid
    # absolute public web URLs for later operator review.
    if parts.scheme.lower() not in ("https", "http") or not parts.hostname or parts.username or parts.password:
        return None
    return value


def field(row, key):
    value = row.get(key)
    return str(value).strip() if value is not None else None


def project_coin_meme(connection, metadata, row):
    required = ("token_address", "token_name", "token_ticker", "createdAt")
    if any(key not in row for key in required):
        return 0  # e.g. comments CSV; no invented joins without its verified schema
    address = field(row, "token_address")
    if not valid_solana_pubkey(address):
        return 0
    ident = (metadata["dataset_id"], metadata["file_sha256"], metadata["member"],
             metadata["row_number"], PROJECTION_VERSION, address)
    created_raw = field(row, "createdAt")
    # The actual Coin-Meme CSV uses DD/MM/YYYY, HH:MM:SS with NO timezone.
    # Keep it raw; do not assume UTC, or backdate system availability to 2024.
    try:
        datetime.strptime(created_raw, "%d/%m/%Y, %H:%M:%S")
        precision = "unknown_timezone"
    except (TypeError, ValueError):
        precision = "unknown"
    a = connection.execute(
        """INSERT OR IGNORE INTO token_metadata_projections
           (dataset_id,file_sha256,member,row_number,projection_version,mint_candidate,
            token_name,token_ticker,description,source_created_raw,source_time_precision,
            first_system_available_at,rights_evidence)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (*ident, field(row, "token_name"), field(row, "token_ticker"),
         field(row, "description"), created_raw, precision,
         metadata["available_at"], metadata["rights_evidence"]),
    )
    # Unknown-time market caps and Raydium migration are future-derived outcome
    # information, NOT an early-token feature. Store in a separate table.
    cap = field(row, "mCap")
    bonded = field(row, "bonding_completeTime")
    if cap or bonded:
        connection.execute(
            """INSERT OR IGNORE INTO token_outcomes_research_only
               (dataset_id,file_sha256,member,row_number,projection_version,mint_candidate,
                market_cap_snapshot_raw,bonding_complete_time_raw,available_at)
               VALUES(?,?,?,?,?,?,?,?,?)""",
            (*ident, cap, bonded, metadata["available_at"]),
        )
    return a.rowcount


def project_memechain(connection, metadata, row):
    if not all(key in row for key in ("address", "platform")):
        return 0
    platform = (field(row, "platform") or "").lower()
    if platform not in ("solana", "sol"):
        return 0
    address = field(row, "address")
    if not valid_solana_pubkey(address):
        return 0
    links = [normalized_url(field(row, key)) for key in ("website", "twitter", "telegram", "discord")]
    if not any(links):
        return 0
    outcome = connection.execute(
        """INSERT OR IGNORE INTO token_social_link_projections
          (dataset_id,file_sha256,member,row_number,projection_version,mint_candidate,
           source_platform,website,twitter,telegram,discord,first_system_available_at,
           rights_evidence)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (metadata["dataset_id"],metadata["file_sha256"],metadata["member"],
         metadata["row_number"],PROJECTION_VERSION,address,platform,*links,
         metadata["available_at"],metadata["rights_evidence"]),
    )
    return outcome.rowcount


PROJECTORS = {"coin-meme": project_coin_meme, "memechain": project_memechain}


def project_source(db_path: Path, source: str):
    if source not in PROJECTORS:
        raise ValueError("Only verified-schema coin-meme and memechain projections are supported")
    if not db_path.is_file():
        raise FileNotFoundError("Source staging DB must exist; import authorized data first")
    with sqlite3.connect(db_path) as db:
        db.row_factory = sqlite3.Row
        db.executescript(SCHEMA)
        run_id = db.execute(
            "INSERT INTO dataset_projection_runs(dataset_id,projection_version,started_at,status) VALUES(?,?,?,'running')",
            (source,PROJECTION_VERSION,utc_now()),
        ).lastrowid
        db.commit()
        processed = inserted = skipped = 0
        try:
            read_cursor = db.execute(
                """SELECT dataset_id,file_sha256,member,row_number,payload_json,
                          available_at,rights_evidence FROM staged_observations
                   WHERE dataset_id=? ORDER BY file_sha256,member,row_number""",(source,))
            while rows := read_cursor.fetchmany(500):
                for item in rows:
                    processed += 1
                    row = json.loads(item["payload_json"])
                    if not isinstance(row, dict):
                        raise ValueError("Staged row must be an object")
                    added = PROJECTORS[source](db, item, row)
                    inserted += added
                    skipped += (added == 0)
                db.commit()
            db.execute(
                """UPDATE dataset_projection_runs SET status='completed',completed_at=?,
                   processed=?,inserted=?,skipped=? WHERE run_id=?""",
                (utc_now(),processed,inserted,skipped,run_id))
            db.commit()
        except Exception:
            db.rollback()
            db.execute(
                """UPDATE dataset_projection_runs SET status='failed',completed_at=?,
                   processed=?,inserted=?,skipped=? WHERE run_id=?""",
                (utc_now(),processed,inserted,skipped,run_id))
            db.commit()
            raise
    return {"dataset":source,"projection_version":PROJECTION_VERSION,"processed":processed,
            "inserted":inserted,"skipped_or_previously_projected":skipped,
            "chain_mint_verified":False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source",choices=sorted(PROJECTORS),required=True)
    parser.add_argument("--db",type=Path,required=True)
    args=parser.parse_args(argv)
    print(json.dumps(project_source(args.db,args.source),ensure_ascii=False))


if __name__=="__main__":
    main()
