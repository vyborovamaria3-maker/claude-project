"""Real disposable PostgreSQL integration of read-only X/TG source text adapters.

Skipped unless POTAPOFF_TEST_POSTGRES_DSN points at a disposable CI database.
Never touches external X/TG accounts or production databases.
"""
from __future__ import annotations

import os
import secrets
import unittest
from datetime import datetime, timezone

from intelligence.nlp.sources import read_collector_texts


class PostgresSourceIntegrationTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("POTAPOFF_TEST_POSTGRES_DSN"),
                         "requires disposable CI PostgreSQL")
    def test_read_only_cross_collector_source_queries(self):
        import psycopg
        dsn = os.environ["POTAPOFF_TEST_POSTGRES_DSN"]
        schema = "sentiment_fixture_" + secrets.token_hex(6)
        with psycopg.connect(dsn) as admin:
            admin.execute('CREATE SCHEMA "' + schema + '"')
            admin.execute(
                'CREATE TABLE "' + schema + '".twitter_tweets ('
                'tweet_id TEXT PRIMARY KEY, text TEXT, '
                'updated_at TIMESTAMPTZ NOT NULL, posted_at TIMESTAMPTZ)'
            )
            admin.execute(
                'CREATE TABLE "' + schema + '".tg_sources ('
                'id BIGINT PRIMARY KEY, peer_id TEXT)'
            )
            admin.execute(
                'CREATE TABLE "' + schema + '".tg_messages ('
                'source_id BIGINT, message_id BIGINT, text TEXT, '
                'collected_at TIMESTAMPTZ, posted_at TIMESTAMPTZ, '
                'deleted_at TIMESTAMPTZ)'
            )
            instant = datetime(2026, 10, 19, 11, tzinfo=timezone.utc)
            admin.execute(
                'INSERT INTO "' + schema + '".twitter_tweets VALUES (%s,%s,%s,%s)',
                ("123", "The Solana token looks bullish today", instant, instant),
            )
            admin.execute(
                'INSERT INTO "' + schema + '".tg_sources VALUES (%s,%s)',
                (1, "-100123"),
            )
            admin.execute(
                'INSERT INTO "' + schema + '".tg_messages VALUES (%s,%s,%s,%s,%s,%s)',
                (1, 22, "Сегодня рост хороший", instant, instant, None),
            )
            admin.execute(
                'INSERT INTO "' + schema + '".tg_messages VALUES (%s,%s,%s,%s,%s,%s)',
                (1, 23, "Удалённое сообщение", instant, instant, instant),
            )
        try:
            def isolated_connect(conn_string, **kwargs):
                return psycopg.connect(
                    conn_string, options="-c search_path=" + schema, **kwargs
                )
            x = read_collector_texts(
                "x", dsn=dsn, limit=5, connect=isolated_connect
            )
            tg = read_collector_texts(
                "tg", dsn=dsn, limit=5, connect=isolated_connect
            )
            self.assertEqual(len(x), 1)
            self.assertEqual(x[0].source_id, "x:tweet:123")
            self.assertEqual(x[0].observed_at, instant)
            self.assertEqual(len(tg), 1, "soft-deleted message cannot be scored")
            self.assertEqual(tg[0].source_id, "tg:message:-100123:22")
            self.assertEqual(tg[0].observed_at, instant)
            # Verify no extra row was written by the read-only adapters.
            with psycopg.connect(dsn, options="-c search_path=" + schema) as check:
                self.assertEqual(check.execute(
                    "SELECT count(*) FROM twitter_tweets").fetchone()[0], 1)
                self.assertEqual(check.execute(
                    "SELECT count(*) FROM tg_messages").fetchone()[0], 2)
        finally:
            with psycopg.connect(dsn) as admin:
                admin.execute('DROP SCHEMA "' + schema + '" CASCADE')


if __name__ == "__main__":
    unittest.main()
