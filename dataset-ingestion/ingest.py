"""Offline rights-gated historical staging. No downloads, credentials or Intelligence writes."""
import argparse
import csv
import hashlib
import io
import json
import re
import sqlite3
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

CATALOG = Path(__file__).with_name("catalog.json")
BASE58 = re.compile(r"(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])")
TIME_FIELDS = ("created_at", "createdAt", "timestamp", "datetime", "date", "posted_at", "published_at")
ZIP_LIMIT = 2_000_000_000
SCHEMA = """
CREATE TABLE IF NOT EXISTS staged_observations (
 dataset_id TEXT NOT NULL, file_sha256 TEXT NOT NULL, member TEXT NOT NULL,
 row_number INTEGER NOT NULL, payload_sha256 TEXT NOT NULL, source_record_id TEXT,
 occurred_at TEXT, time_precision TEXT NOT NULL, observed_at TEXT NOT NULL,
 ingested_at TEXT NOT NULL, available_at TEXT NOT NULL, mint_candidate TEXT,
 mint_verified INTEGER NOT NULL DEFAULT 0 CHECK (mint_verified = 0),
 rights_evidence TEXT NOT NULL, payload_json TEXT NOT NULL,
 PRIMARY KEY(dataset_id,file_sha256,member,row_number)
);
CREATE INDEX IF NOT EXISTS staged_source_time ON staged_observations(dataset_id,occurred_at);
CREATE TABLE IF NOT EXISTS dataset_artifacts (
 dataset_id TEXT NOT NULL, file_sha256 TEXT NOT NULL, original_filename TEXT NOT NULL,
 file_bytes INTEGER NOT NULL, first_imported_at TEXT NOT NULL, rights_evidence TEXT NOT NULL,
 PRIMARY KEY(dataset_id,file_sha256)
);
CREATE TABLE IF NOT EXISTS dataset_import_runs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT NOT NULL, file_sha256 TEXT NOT NULL,
 started_at TEXT NOT NULL, completed_at TEXT, status TEXT NOT NULL
 CHECK(status IN ('running','completed','failed')),
 rows_seen INTEGER NOT NULL DEFAULT 0, rows_added INTEGER NOT NULL DEFAULT 0,
 error_type TEXT, rights_evidence TEXT NOT NULL
);
"""


def now_utc():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def catalog():
    raw = json.loads(CATALOG.read_text(encoding="utf-8"))
    if raw.get("schema_version") != 1:
        raise ValueError("Unsupported dataset catalog version")
    return {s["id"]: s for s in raw["sources"]}


def authorize(source, path, purpose):
    if not path.is_file():
        raise PermissionError("Authorization file is required; all candidates begin unapproved")
    entry = json.loads(path.read_text(encoding="utf-8")).get(source)
    if not isinstance(entry, dict) or entry.get("status") != "approved":
        raise PermissionError("Dataset has no operator-approved rights review")
    if purpose not in entry.get("allowed_uses", []):
        raise PermissionError("Intended use is not authorized")
    if not entry.get("evidence_reference") or not entry.get("reviewed_by"):
        raise PermissionError("Authorization evidence and reviewer are required")
    return entry


def sha_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1048576), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_time(row):
    for name in TIME_FIELDS:
        value = str(row.get(name) or "").strip()
        if not value:
            continue
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            try:
                datetime.fromisoformat(value)
            except ValueError:
                continue
            return value, "day"
        try:
            if value.isdigit():
                epoch = int(value)
                if epoch > 100_000_000_000:
                    epoch /= 1000
                date = datetime.fromtimestamp(epoch, tz=timezone.utc)
            else:
                date = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if date.tzinfo is None:
                    return None, "unknown_timezone"
                date = date.astimezone(timezone.utc)
            return date.isoformat().replace("+00:00", "Z"), "second"
        except (ValueError, OverflowError):
            continue
    return None, "unknown"


def iterate_rows(path):
    def read(handle, name):
        if name.lower().endswith(".csv"):
            reader = csv.DictReader(handle)
            if not reader.fieldnames:
                raise ValueError("CSV has no header: " + name)
            for number, row in enumerate(reader, start=2):
                yield name, number, dict(row)
        elif name.lower().endswith(".jsonl"):
            for number, line in enumerate(handle, start=1):
                if line.strip():
                    item = json.loads(line)
                    if not isinstance(item, dict):
                        raise ValueError("Each JSONL line must contain an object")
                    yield name, number, item

    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            members = sorted((i for i in archive.infolist() if not i.is_dir()), key=lambda x: x.filename)
            if sum(i.file_size for i in members) > ZIP_LIMIT:
                raise ValueError("ZIP archive exceeds 2 GB uncompressed safety limit")
            names = [i.filename for i in members]
            if len(names) != len(set(names)):
                raise ValueError("Ambiguous duplicate ZIP member names")
            for member in members:
                if member.filename.lower().endswith((".csv", ".jsonl")):
                    with archive.open(member) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as handle:
                        yield from read(handle, member.filename)
    elif path.suffix.lower() in (".csv", ".jsonl"):
        with path.open(encoding="utf-8-sig", newline="") as handle:
            yield from read(handle, path.name)
    else:
        raise ValueError("Only CSV/JSONL and ZIP archives are implemented; Parquet adapter is separate")


def import_file(source, input_file, db_file, authorization, purpose="research", limit=None):
    registry = catalog()
    if source not in registry:
        raise ValueError("Unknown dataset ID")
    rights = authorize(source, authorization, purpose)
    extension = input_file.suffix.lower().lstrip(".")
    if extension not in registry[source]["formats"] or extension not in ("csv", "jsonl", "zip"):
        raise ValueError("Input format not supported for this dataset")
    if limit is not None and limit <= 0:
        raise ValueError("Import limit must be positive")
    digest = sha_file(input_file)
    imported = now_utc()
    db_file.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_file) as db:
        db.executescript(SCHEMA)
        db.execute("""INSERT OR IGNORE INTO dataset_artifacts
           (dataset_id,file_sha256,original_filename,file_bytes,first_imported_at,rights_evidence)
           VALUES(?,?,?,?,?,?)""",
           (source,digest,input_file.name,input_file.stat().st_size,imported,rights["evidence_reference"]))
        run_id = db.execute("""INSERT INTO dataset_import_runs
           (dataset_id,file_sha256,started_at,status,rights_evidence)
           VALUES(?,?,?,'running',?)""",
           (source,digest,imported,rights["evidence_reference"])).lastrowid
        db.commit()
        count = 0
        added = 0
        try:
            for member, number, row in iterate_rows(input_file):
                if limit is not None and count >= limit:
                    break
                count += 1
                payload = json.dumps(row, ensure_ascii=False, sort_keys=True, default=str, separators=(",", ":"))
                occurred, precision = parse_time(row)
                sample = next((str(row[k]) for k in ("mint", "mint_address", "token_address", "content", "text", "comment") if row.get(k)), "")
                mint_match = BASE58.search(sample)
                original_id = next((str(row[k]) for k in ("id", "message_id", "comment_id") if row.get(k) is not None), None)
                cursor=db.execute("""INSERT OR IGNORE INTO staged_observations
                    (dataset_id,file_sha256,member,row_number,payload_sha256,source_record_id,
                    occurred_at,time_precision,observed_at,ingested_at,available_at,
                    mint_candidate,mint_verified,rights_evidence,payload_json)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)""",
                    (source,digest,member,number,hashlib.sha256(payload.encode()).hexdigest(),
                     original_id,occurred,precision,imported,imported,imported,
                     mint_match.group() if mint_match else None,rights["evidence_reference"],payload))
                added+=cursor.rowcount
                if count % 500 == 0:
                    db.commit()
            db.execute("UPDATE dataset_import_runs SET status='completed',completed_at=?,rows_seen=?,rows_added=? WHERE id=?",
                       (now_utc(),count,added,run_id))
            db.commit()
        except Exception as error:
            db.rollback()
            db.execute("UPDATE dataset_import_runs SET status='failed',completed_at=?,rows_seen=?,rows_added=?,error_type=? WHERE id=?",
                       (now_utc(),count,added,type(error).__name__,run_id))
            db.commit()
            raise
        total = db.execute("SELECT COUNT(*) FROM staged_observations WHERE dataset_id=?", (source,)).fetchone()[0]
    return {"source":source,"file_sha256":digest,"rows_processed":count,
            "rows_added":added,"total_staged":total,"earliest_system_availability":imported}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("catalog")
    inspect = sub.add_parser("inspect")
    inspect.add_argument("--input", type=Path, required=True)
    run = sub.add_parser("import")
    run.add_argument("--source", required=True)
    run.add_argument("--input", type=Path, required=True)
    run.add_argument("--authorization", type=Path, required=True)
    run.add_argument("--db", type=Path, required=True)
    run.add_argument("--purpose", choices=("research","commercial"), default="research")
    run.add_argument("--limit", type=int)
    args = parser.parse_args(argv)
    if args.command == "catalog":
        print(json.dumps(list(catalog().values()), indent=2, ensure_ascii=False))
    elif args.command == "inspect":
        columns = set()
        count = 0
        for _, _, row in iterate_rows(args.input):
            columns.update(row)
            count += 1
            if count >= 10:
                break
        print(json.dumps({"sampled_rows":count,"columns":sorted(columns)}))
    else:
        print(json.dumps(import_file(args.source,args.input,args.db,args.authorization,args.purpose,args.limit)))


if __name__ == "__main__":
    try:
        main()
    except (PermissionError, ValueError, OSError, sqlite3.Error, zipfile.BadZipFile, json.JSONDecodeError) as exc:
        print("Import rejected:", str(exc), file=sys.stderr)
        sys.exit(2)
