import importlib.util
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

try:
    import pyarrow as pa
    import pyarrow.parquet as pq
except ImportError:
    pa = pq = None

DIR=Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location("source_ingest",DIR/"ingest.py")
ingest=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ingest)

MINT="5njPgyEfBDvGxHtMTN86yQnNr1XTd3zy9D2eb84zpump"


@unittest.skipIf(pa is None, "PyArrow optional research dependency not installed")
class ParquetPilotTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.db=self.root/"staging.sqlite"
        self.file=self.root/"melt-sample.parquet"
        self.auth=self.root/"rights.json"
        self.auth.write_text(json.dumps({"melt":{
            "status":"approved","allowed_uses":["research"],
            "reviewed_by":"synthetic-test","evidence_reference":"synthetic-fixture"
        }}),encoding="utf8")
        table=pa.table({
            "id":["tx-1","tx-2","tx-3"],
            "mint":[MINT,MINT,MINT],
            "timestamp":[
                datetime(2024,12,1,10,0,0,tzinfo=timezone.utc),
                datetime(2024,12,1,10,0,1,tzinfo=timezone.utc),
                datetime(2024,12,1,10,0,2,tzinfo=timezone.utc)
            ],
            "price_usd":[0.1,0.2,0.3]
        })
        pq.write_table(table,self.file,row_group_size=1)

    def test_no_unbounded_parquet_import(self):
        with self.assertRaisesRegex(ValueError,"--limit"):
            ingest.import_file("melt",self.file,self.db,self.auth)
        self.assertFalse(self.db.exists())
        with self.assertRaisesRegex(ValueError,"--limit"):
            ingest.import_file("melt",self.file,self.db,self.auth,limit=100001)

    def test_bounded_streaming_and_historical_time_precision(self):
        one=ingest.import_file("melt",self.file,self.db,self.auth,limit=2)
        self.assertEqual(one["rows_processed"],2)
        self.assertEqual(one["rows_added"],2)
        with sqlite3.connect(self.db) as db:
            rows=db.execute(
                "SELECT source_record_id,occurred_at,time_precision,available_at,mint_verified "
                "FROM staged_observations ORDER BY row_number"
            ).fetchall()
        self.assertEqual([x[0] for x in rows],["tx-1","tx-2"])
        self.assertEqual(rows[0][1],"2024-12-01T10:00:00Z")
        self.assertEqual(rows[0][2],"second")
        self.assertGreater(rows[0][3],"2026-01-01")
        self.assertEqual(rows[0][4],0)
        repeated=ingest.import_file("melt",self.file,self.db,self.auth,limit=2)
        self.assertEqual(repeated["rows_added"],0)


if __name__=="__main__":
    unittest.main()
