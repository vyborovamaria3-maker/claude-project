from __future__ import annotations

import unittest
from dataclasses import dataclass

from app.database import ColumnInfo
from app.database_inventory import build_database_inventory


@dataclass
class FakeConfig:
    id: str = "prod"
    label: str = "Production"
    kind: str = "sqlite"
    role: str = "primary"


class FakeSource:
    config = FakeConfig()

    def tables(self):
        return ["wallets", "tokens", "twitter_accounts", "telegram_users", "telegram_messages"]

    def columns(self, table):
        return [
            ColumnInfo("id", "bigint", nullable=False, primary_key=True),
            ColumnInfo("created_at", "timestamp with time zone"),
        ]

    def estimate_count(self, table):
        return {
            "wallets": 11,
            "tokens": 7,
            "twitter_accounts": 5,
            "telegram_users": 13,
            "telegram_messages": 101,
        }[table]


class FakeRegistry:
    def all(self):
        return [FakeSource()]


class DatabaseInventoryTests(unittest.TestCase):
    def test_full_schema_and_entity_counts_are_reported(self):
        payload = build_database_inventory(FakeRegistry())
        self.assertEqual(payload["totals"], {"sources": 1, "tables": 5, "columns": 10, "rows": 137})
        self.assertEqual(payload["entities"]["wallets"], 11)
        self.assertEqual(payload["entities"]["coins"], 7)
        self.assertEqual(payload["entities"]["twitter_accounts"], 5)
        self.assertEqual(payload["entities"]["telegram_accounts"], 13)
        self.assertEqual(payload["entities"]["telegram_messages"], 101)
        source = payload["sources"][0]
        self.assertEqual(source["table_count"], 5)
        self.assertEqual(source["column_count"], 10)
        self.assertEqual(source["tables"][0]["columns"][0]["primary_key"], True)


if __name__ == "__main__":
    unittest.main()
