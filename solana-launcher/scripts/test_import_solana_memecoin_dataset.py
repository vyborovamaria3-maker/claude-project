#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("import_solana_memecoin_dataset.py")
SPEC = importlib.util.spec_from_file_location("memecoin_importer", MODULE_PATH)
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)


class DatasetImporterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="memecoin-dataset-test-")
        self.db_path = Path(self.temp.name) / "trade.db"
        self.conn = sqlite3.connect(str(self.db_path)
        )
        self.conn.row_factory = sqlite3.Row
        IMPORTER.ensure_schema(self.conn)
        self.conn.executescript("""
          CREATE TABLE token_trades (mint TEXT, signature TEXT);
          CREATE TABLE token_trade_fills (mint TEXT, signature TEXT, leg_index INTEGER);
          CREATE TABLE wallet_stats (address TEXT);
          CREATE TABLE wallet_token_stats (address TEXT, mint TEXT);
          INSERT INTO token_trades VALUES ('mint','real-signature');
          INSERT INTO token_trade_fills VALUES ('mint','real-signature',0);
          INSERT INTO wallet_stats VALUES ('wallet');
          INSERT INTO wallet_token_stats VALUES ('wallet','mint');
        """)
        self.dataset_id = IMPORTER.DATASET_ID
        self.now = 1_785_000_000

    def tearDown(self):
        self.conn.close()
        self.temp.cleanup()

    def import_rows(self, file_name, rows, digest):
        return IMPORTER.import_file_rows(
            self.conn, self.dataset_id, file_name, iter(rows), digest,
            len(rows), self.now,
        )

    def test_trade_rows_are_lossless_by_source_row_not_deduped(self):
        rows = [
            {"wallet":"wallet-A","token_address":"mint-A","side":"BUY",
             "amount_usd":2.5,"ts":1_785_000_000},
            # Similar rows are valid partial fills and must remain separate.
            {"wallet":"wallet-A","token_address":"mint-A","side":"BUY",
             "amount_usd":2.5,"ts":1_785_000_000},
            {"wallet":"","token_address":"mint-A","side":"transfer",
             "amount_usd":-1,"ts":"not-a-time"},
        ]
        report = self.import_rows("trades-000.parquet", rows, "a" * 64)
        self.assertEqual(report["imported_rows"], 3)
        self.assertEqual(report["incomplete_rows"], 1)
        saved = self.conn.execute(
            "SELECT source_row,wallet,side,side_raw,amount_usd,ts_epoch,quality_status FROM external_memecoin_trades ORDER BY source_row"
        ).fetchall()
        self.assertEqual(len(saved), 3)
        self.assertEqual([r["source_row"] for r in saved], [0, 1, 2])
        self.assertEqual(saved[0]["side"], "buy")
        self.assertEqual(saved[0]["side_raw"], "BUY")
        self.assertEqual(saved[0]["amount_usd"], 2.5)
        self.assertEqual(saved[2]["quality_status"], "incomplete")
        self.assertEqual(self.conn.execute(
            "SELECT quality_reasons_json FROM external_memecoin_trades WHERE source_row=2"
        ).fetchone()[0], '["missing_wallet","invalid_side","invalid_amount_usd","invalid_timestamp"]')

    def test_same_file_replay_skips_and_keeps_original_rows(self):
        rows = [{"wallet":"w","token_address":"m","side":"sell","amount_usd":4,"ts":1_785_000_000}]
        self.import_rows("trades-000.parquet", rows, "b" * 64)
        def must_not_run():
            raise AssertionError("unchanged file should be skipped before reading rows")
            yield {}
        report = IMPORTER.import_file_rows(
            self.conn, self.dataset_id, "trades-000.parquet", must_not_run(),
            "b" * 64, 1, self.now + 1,
        )
        self.assertEqual(report["status"], "skipped_unchanged")
        self.assertEqual(self.conn.execute("SELECT count(*) FROM external_memecoin_trades").fetchone()[0], 1)

    def test_changed_file_replaces_only_its_own_shard(self):
        row = {"wallet":"w","token_address":"m","side":"buy","amount_usd":1,"ts":1_785_000_000}
        self.import_rows("trades-000.parquet", [row], "c" * 64)
        self.import_rows("trades-001.parquet", [row], "d" * 64)
        self.import_rows("trades-000.parquet", [dict(row, amount_usd=9)], "e" * 64)
        saved = self.conn.execute(
            "SELECT source_file,amount_usd FROM external_memecoin_trades ORDER BY source_file"
        ).fetchall()
        self.assertEqual([(r[0],r[1]) for r in saved], [
            ("trades-000.parquet",9.0),("trades-001.parquet",1.0)
        ])

    def test_timestamp_units_and_bad_text(self):
        self.assertEqual(IMPORTER._epoch_seconds(1_785_000_000_000), 1_785_000_000)
        self.assertEqual(IMPORTER._epoch_seconds("2026-06-10T12:00:00Z"), 1_781_092_800)
        self.assertIsNone(IMPORTER._epoch_seconds("not-a-time"))
        self.assertIsNone(IMPORTER._epoch_seconds("nan"))
        self.assertIsNone(IMPORTER._epoch_seconds("inf"))

    def test_all_nontrade_table_shapes_preserve_raw_source_columns(self):
        cases = [
            ("tokens.parquet", {"sample_id":1,"token_address":"mint","captured_at":"2026-06-10T12:00:00Z",
                "symbol":"ABC","max_return_24h":3.2,"reaches_2x":True}, "external_memecoin_tokens"),
            ("ohlcv.parquet", {"token_address":"mint","ts":1_785_000_000,"open":1,"high":2,"low":0.5,"close":1.5,"volume":9}, "external_memecoin_ohlcv"),
            ("sequences.parquet", {"sample_id":1,"bucket":0,"buy_usd":3,"sell_usd":1,"n_trades":2,"n_smart_buy":1,"n_buyers":2}, "external_memecoin_sequences"),
            ("wallets.parquet", {"address":"wallet","wallet_type":"smart_money","win_rate":0.5,"avg_pnl_ratio":1.2}, "external_memecoin_wallets"),
            ("wallet_funding.parquet", {"wallet":"wallet","funder":"funder","ts":1_785_000_000,"amount_sol":0.25}, "external_memecoin_wallet_funding"),
        ]
        for index, (file_name, row, table) in enumerate(cases):
            with self.subTest(file_name=file_name):
                self.import_rows(file_name, [row], format(index + 10, "064x"))
                saved = self.conn.execute(
                    f"SELECT * FROM {table} WHERE dataset_id=? AND source_file=?",
                    (self.dataset_id,file_name),
                ).fetchone()
                self.assertIsNotNone(saved)
                self.assertEqual(saved["source_row"], 0)
                self.assertIn("raw_json", saved.keys())
                self.assertTrue(saved["raw_json"].startswith("{"))

    def test_canonical_trade_and_pnl_tables_are_never_written(self):
        before = IMPORTER.canonical_counts(self.conn)
        self.import_rows("trades-000.parquet", [
            {"wallet":"wallet","token_address":"mint","side":"buy","amount_usd":1,"ts":1_785_000_000}
        ], "f" * 64)
        after = IMPORTER.canonical_counts(self.conn)
        self.assertEqual(before, after)
        self.assertEqual(self.conn.execute("SELECT count(*) FROM token_trades").fetchone()[0], 1)
        self.assertEqual(self.conn.execute("SELECT count(*) FROM token_trade_fills").fetchone()[0], 1)

    def test_bad_file_rolls_back_replacement(self):
        row = {"wallet":"w","token_address":"m","side":"buy","amount_usd":1,"ts":1_785_000_000}
        self.import_rows("trades-000.parquet", [row], "1" * 64)
        def broken_rows():
            yield row
            raise RuntimeError("simulated truncated Parquet reader")
        with self.assertRaisesRegex(RuntimeError, "truncated"):
            IMPORTER.import_file_rows(
                self.conn, self.dataset_id, "trades-000.parquet", broken_rows(),
                "2" * 64, 2, self.now + 1,
            )
        saved = self.conn.execute(
            "SELECT source_sha256,source_rows FROM external_memecoin_import_files WHERE source_file='trades-000.parquet'"
        ).fetchone()
        self.assertEqual((saved[0],saved[1]), ("1" * 64,1))
        self.assertEqual(self.conn.execute("SELECT amount_usd FROM external_memecoin_trades").fetchone()[0], 1.0)

    def test_backup_is_readonly_verified_and_preserves_existing_destination(self):
        self.conn.commit()
        backup = self.db_path.with_name("backup.db")
        before = self.db_path.read_bytes()
        IMPORTER.backup_database(self.db_path, backup)
        saved = sqlite3.connect(backup)
        try:
            self.assertEqual(saved.execute("PRAGMA quick_check").fetchone()[0], "ok")
            self.assertEqual(saved.execute("SELECT signature FROM token_trades").fetchone()[0], "real-signature")
        finally:
            saved.close()
        self.assertEqual(self.db_path.read_bytes(), before)
        with self.assertRaises(FileExistsError):
            IMPORTER.backup_database(self.db_path, backup)

    def test_concurrent_backup_creator_is_never_overwritten(self):
        backup = self.db_path.with_name("racing-backup.db")
        original_exists = Path.exists
        raced = False

        def exists(candidate):
            nonlocal raced
            if candidate == backup and not raced:
                raced = True
                backup.write_bytes(b"other-process-backup")
                return False
            return original_exists(candidate)

        with patch.object(Path, "exists", exists):
            with self.assertRaises(FileExistsError):
                IMPORTER.backup_database(self.db_path, backup)
        self.assertEqual(backup.read_bytes(), b"other-process-backup")

    def test_real_parquet_streaming_preserves_source_rows_and_hash(self):
        import pyarrow as pa
        import pyarrow.parquet as pq

        rows = [{"wallet": "w", "token_address": "m", "side": "buy",
                 "amount_usd": 1.5, "ts": self.now}] * 2
        source = self.db_path.with_name("trades-000.parquet")
        pq.write_table(pa.Table.from_pylist(rows), source, row_group_size=1)
        info = IMPORTER.parquet_info(source)
        self.assertEqual(info["rows"], 2)
        report = IMPORTER.import_file_rows(
            self.conn, self.dataset_id, source.name,
            IMPORTER.iter_parquet_rows(source, batch_size=1), info["sha256"], 2, self.now,
        )
        self.assertEqual(report["imported_rows"], 2)
        self.assertEqual(IMPORTER.sha256_file(source), info["sha256"])
        self.assertEqual([row[0] for row in self.conn.execute(
            "SELECT source_row FROM external_memecoin_trades ORDER BY source_row"
        )], [0, 1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
