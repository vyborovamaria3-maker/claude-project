from __future__ import annotations

import unittest
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from intelligence.core.models import IntelligenceDocument
from intelligence.errors.exceptions import StorageError
from intelligence.storage.postgres_store import PostgresDocumentStore


NOW = datetime(2026, 8, 10, 5, 0, tzinfo=timezone.utc)


def row(document_id: str = "doc-1", raw_hash: str | None = "a" * 64) -> dict[str, Any]:
    return {
        "id": document_id,
        "source": "web",
        "content": "evidence",
        "collected_at": NOW,
        "url": "https://example.com",
        "author": "example.com",
        "provider": "jina-reader",
        "published_at": None,
        "entities_json": ["webpage", "example.com"],
        "metrics_json": {"characters": 8},
        "raw_hash": raw_hash,
    }


def document(document_id: str = "doc-1", raw_hash: str | None = "a" * 64) -> IntelligenceDocument:
    return IntelligenceDocument(
        id=document_id,
        source="web",
        content="evidence",
        collected_at=NOW,
        url="https://example.com",
        author="example.com",
        provider="jina-reader",
        entities=["webpage", "example.com"],
        metrics={"characters": 8},
        raw_hash=raw_hash,
    )


class FakeResult:
    def __init__(self, *, one: Any = None, many: list[Any] | None = None) -> None:
        self.one = one
        self.many = many or []

    def fetchone(self) -> Any:
        return self.one

    def fetchall(self) -> list[Any]:
        return list(self.many)


class FakeConnection:
    def __init__(self, results: list[FakeResult]) -> None:
        self.results = list(results)
        self.calls: list[tuple[str, Any]] = []
        self.exited_with: Any = None

    def __enter__(self) -> "FakeConnection":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.exited_with = exc_type

    def execute(self, query: str, params: Any = None) -> FakeResult:
        self.calls.append((query, params))
        if not self.results:
            raise AssertionError("unexpected SQL execution")
        return self.results.pop(0)


class ConnectFactory:
    def __init__(self, connections: list[FakeConnection]) -> None:
        self.connections = list(connections)
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, dsn: str, **kwargs: Any) -> FakeConnection:
        self.calls.append((dsn, kwargs))
        if not self.connections:
            raise AssertionError("unexpected connection")
        return self.connections.pop(0)


class PostgresDocumentStoreTests(unittest.TestCase):
    def test_save_inserts_native_jsonb_and_returns_document(self) -> None:
        connection = FakeConnection([FakeResult(one=row())])
        factory = ConnectFactory([connection])
        store = PostgresDocumentStore("postgresql://db/intelligence", connect_factory=factory)

        saved = store.save(document())

        self.assertEqual(saved.id, "doc-1")
        self.assertEqual(saved.entities, ["webpage", "example.com"])
        self.assertEqual(len(connection.calls), 1)
        query, params = connection.calls[0]
        self.assertIn("ON CONFLICT (raw_hash) DO NOTHING", query)
        self.assertIsInstance(params[8], Jsonb)
        self.assertIsInstance(params[9], Jsonb)
        self.assertIn("row_factory", factory.calls[0][1])
        self.assertEqual(factory.calls[0][1]["connect_timeout"], 5)

    def test_save_duplicate_hash_returns_existing_document(self) -> None:
        connection = FakeConnection(
            [
                FakeResult(one=None),
                FakeResult(one=row("existing")),
            ]
        )
        store = PostgresDocumentStore(
            "postgresql://db/intelligence",
            connect_factory=ConnectFactory([connection]),
        )

        saved = store.save(document("incoming"))

        self.assertEqual(saved.id, "existing")
        self.assertEqual(len(connection.calls), 2)
        self.assertIn("WHERE raw_hash = %s", connection.calls[1][0])

    def test_get_list_and_list_recent_map_rows(self) -> None:
        get_connection = FakeConnection([FakeResult(one=row())])
        list_connection = FakeConnection([FakeResult(many=[row("a"), row("b", "b" * 64)])])
        recent_connection = FakeConnection([FakeResult(many=[row("b", "b" * 64)])])
        factory = ConnectFactory([get_connection, list_connection, recent_connection])
        store = PostgresDocumentStore("postgresql://db/intelligence", connect_factory=factory)

        self.assertEqual(store.get("doc-1").id, "doc-1")
        self.assertEqual([item.id for item in store.list_all()], ["a", "b"])
        self.assertEqual([item.id for item in store.list_recent(1)], ["b"])
        self.assertEqual(recent_connection.calls[0][1], (1,))

    def test_list_recent_rejects_bool_zero_and_negative_limits(self) -> None:
        store = PostgresDocumentStore(
            "postgresql://db/intelligence",
            connect_factory=ConnectFactory([]),
        )
        for value in (True, 0, -1):
            with self.subTest(value=value), self.assertRaises(ValueError):
                store.list_recent(value)

    def test_malformed_json_shapes_are_rejected(self) -> None:
        bad = row()
        bad["entities_json"] = {"not": "a-list"}
        connection = FakeConnection([FakeResult(one=bad)])
        store = PostgresDocumentStore(
            "postgresql://db/intelligence",
            connect_factory=ConnectFactory([connection]),
        )
        with self.assertRaises(StorageError):
            store.get("doc-1")

    def test_connection_error_does_not_expose_dsn_or_driver_message(self) -> None:
        class FailingFactory:
            def __call__(self, dsn: str, **kwargs: Any) -> Any:
                raise psycopg.OperationalError("password=super-secret host=internal-db")

        store = PostgresDocumentStore(
            "postgresql://user:dsn-secret@internal-db/intelligence",
            connect_factory=FailingFactory(),
        )
        with self.assertRaises(StorageError) as captured:
            store.get("doc-1")
        message = str(captured.exception)
        self.assertNotIn("super-secret", message)
        self.assertNotIn("dsn-secret", message)
        self.assertNotIn("internal-db", message)

    def test_empty_dsn_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            PostgresDocumentStore("  ")


if __name__ == "__main__":
    unittest.main()
