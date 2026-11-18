import importlib.util
import json
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / "ingest.py"
SPEC = importlib.util.spec_from_file_location("source_ingest", PATH)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)

class ImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.csv = self.root / "comments.csv"
        self.csv.write_text("id,created_at,content\n42,2024-05-04T10:00:00Z,hello\n43,2024-05-05,world\n", encoding="utf-8")
        self.db = self.root / "staging.sqlite"
        self.auth = self.root / "rights.json"

    def approved(self):
        self.auth.write_text(json.dumps({"coin-meme":{"status":"approved",
            "allowed_uses":["research"],"reviewed_by":"test",
            "evidence_reference":"synthetic-fixture"}}),encoding="utf-8")

    def test_default_deny(self):
        with self.assertRaises(PermissionError):
            module.import_file("coin-meme",self.csv,self.db,self.auth)
        self.assertFalse(self.db.exists())

    def test_idempotent_replay_and_no_history_backdating(self):
        self.approved()
        module.import_file("coin-meme",self.csv,self.db,self.auth)
        with sqlite3.connect(self.db) as db:
            first = db.execute("SELECT available_at FROM staged_observations WHERE row_number=2").fetchone()[0]
            precision = db.execute("SELECT time_precision,mint_verified FROM staged_observations WHERE row_number=3").fetchone()
        self.assertGreater(first, "2026-01-01")
        self.assertEqual(precision, ("day",0))
        module.import_file("coin-meme",self.csv,self.db,self.auth)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM staged_observations").fetchone()[0],2)
            self.assertEqual(db.execute("SELECT available_at FROM staged_observations WHERE row_number=2").fetchone()[0],first)

    def test_no_commercial_permission(self):
        self.approved()
        with self.assertRaises(PermissionError):
            module.import_file("coin-meme",self.csv,self.db,self.auth,"commercial")

    def test_zip_supported(self):
        self.approved()
        z = self.root / "comments.zip"
        with zipfile.ZipFile(z,"w") as archive:
            archive.write(self.csv,"data/comments.csv")
        self.assertEqual(module.import_file("coin-meme",z,self.db,self.auth)["rows_processed"],2)

    def test_no_fabricated_timezone(self):
        self.assertEqual(module.parse_time({"created_at":"2024-01-01T10:00:00"}),(None,"unknown_timezone"))

    def test_parquet_requires_explicit_adapter(self):
        self.approved()
        parquet = self.root / "x.parquet"
        parquet.write_bytes(b"PAR1")
        with self.assertRaises(PermissionError):
            module.import_file("melt",parquet,self.db,self.auth)

if __name__=="__main__":
    unittest.main()
