from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

ADMIN_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ADMIN_ROOT.parent
sys.path.insert(0, str(ADMIN_ROOT))

from app.postgres_admin_state import PostgresAuditStore, PostgresControlStore, PostgresLiveAnalysisProfileStore
from app.postgres_security_store import PostgresAdminSessionStore
from app.postgres_task_queue import PostgresTaskQueue, TaskState


class PgCompatConnectionTests(unittest.TestCase):
    def test_close_rolls_back_before_pool_context_exit(self) -> None:
        from unittest.mock import patch
        from app import postgres_admin_state

        events: list[str] = []

        class FakeDatabase:
            def rollback(self) -> None:
                events.append("rollback")

        class FakeContext:
            def __init__(self) -> None:
                self.database = FakeDatabase()

            def __enter__(self):
                return self.database

            def __exit__(self, exc_type, exc, traceback) -> None:
                events.append("context_exit")
                if exc_type is None:
                    events.append("context_success_exit")

        context = FakeContext()
        with patch.object(postgres_admin_state, "pooled_connection", return_value=context):
            connection = postgres_admin_state._PgCompatConnection("postgresql://unused")

        connection.close()
        connection.close()

        self.assertEqual(events, ["rollback", "context_exit", "context_success_exit"])



DSN = os.getenv("ADMIN_STATE_TEST_DSN", "").strip()


@unittest.skipUnless(DSN, "ADMIN_STATE_TEST_DSN is not configured")
class PostgresSharedStateTests(unittest.TestCase):
    def test_audit_control_and_analysis_are_cross_instance(self) -> None:
        suffix = uuid.uuid4().hex[:8]
        audit_a = PostgresAuditStore(DSN)
        audit_b = PostgresAuditStore(DSN)
        audit_a.record(action=f"p2_{suffix}", success=True, username="admin", details={"x": 1})
        self.assertTrue(any(row["action"] == f"p2_{suffix}" for row in audit_b.list(1000)))

        control_a = PostgresControlStore(DSN)
        control_b = PostgresControlStore(DSN)
        flag = f"p2.{suffix}"
        control_a.set_flag(flag, True, "shared", "admin")
        self.assertTrue(any(row["name"] == flag and row["enabled"] for row in control_b.flags()))
        alert = control_a.create_alert("warning", f"p2-{suffix}", "shared", "test")
        self.assertTrue(control_b.acknowledge(int(alert["id"]), "admin"))

        profiles_a = PostgresLiveAnalysisProfileStore(DSN)
        profiles_b = PostgresLiveAnalysisProfileStore(DSN)
        key = f"p2_{suffix}"
        created = profiles_a.create_custom(
            "telegram",
            key=key,
            label="P2 shared",
            source="metrics.score",
            value_type="number",
            scale="raw",
            threshold=">= 1",
            enabled=True,
            description="integration",
            username="admin",
        )
        self.assertEqual(created["key"], key)
        self.assertTrue(any(row["key"] == key for row in profiles_b.list("telegram")))
        self.assertTrue(profiles_b.delete_custom("telegram", key, "admin"))

    def test_sessions_and_revocations_are_cross_instance(self) -> None:
        bind_ip = lambda _request: "iphash"
        bind_ua = lambda _request: "uahash"
        a = PostgresAdminSessionStore(DSN, ip_binding=bind_ip, ua_binding=bind_ua)
        b = PostgresAdminSessionStore(DSN, ip_binding=bind_ip, ua_binding=bind_ua)
        now = int(time.time())
        nonce = uuid.uuid4().hex
        payload = {"nonce": nonce, "sub": "admin", "iat": now, "exp": now + 600}
        policy = SimpleNamespace(bind_ip=True, bind_user_agent=True, idle_timeout_seconds=300)
        row = a.get_or_create(payload, object(), policy)
        self.assertEqual(row["nonce"], nonce)
        self.assertEqual(b.validate_and_touch(payload, object(), policy)["nonce"], nonce)
        a.revoke(nonce, now + 600)
        self.assertTrue(b.is_revoked(nonce))

    def test_durable_queue_is_visible_and_claimed_across_instances(self) -> None:
        q1 = PostgresTaskQueue(DSN, workers=1, max_queue=50, max_history=100)
        q2 = PostgresTaskQueue(DSN, workers=1, max_queue=50, max_history=100)
        handler = lambda payload: {"value": int(payload["value"]) + 1}
        q1.register_handler("p2_test", handler)
        q2.register_handler("p2_test", handler)
        q1.start(); q2.start()
        try:
            task = q1.submit(kind="p2_test", owner="admin", payload={"value": 41})
            deadline = time.monotonic() + 5
            current = None
            while time.monotonic() < deadline:
                current = q2.get(task.id)
                if current is not None and current.state in {TaskState.COMPLETED, TaskState.FAILED}:
                    break
                time.sleep(0.05)
            self.assertIsNotNone(current)
            assert current is not None
            self.assertEqual(current.state, TaskState.COMPLETED)
            self.assertEqual(current.result, {"value": 42})
            self.assertEqual(q1.get(task.id).result, {"value": 42})
        finally:
            q1.stop(); q2.stop()

    def test_one_hundred_tasks_complete_across_two_queue_instances(self) -> None:
        q1 = PostgresTaskQueue(DSN, workers=2, max_queue=200, max_history=300)
        q2 = PostgresTaskQueue(DSN, workers=2, max_queue=200, max_history=300)
        handler = lambda payload: {"value": int(payload["value"]) * 2}
        q1.register_handler("p2_stress", handler)
        q2.register_handler("p2_stress", handler)
        q1.start(); q2.start()
        try:
            tasks = [
                (q1 if index % 2 == 0 else q2).submit(kind="p2_stress", owner="admin", payload={"value": index})
                for index in range(100)
            ]
            self.assertEqual(len({task.id for task in tasks}), 100)
            deadline = time.monotonic() + 15
            remaining = {task.id: index for index, task in enumerate(tasks)}
            while remaining and time.monotonic() < deadline:
                for task_id, index in list(remaining.items()):
                    current = q1.get(task_id)
                    if current is not None and current.state == TaskState.COMPLETED:
                        self.assertEqual(current.result, {"value": index * 2})
                        remaining.pop(task_id)
                    elif current is not None and current.state == TaskState.FAILED:
                        self.fail(f"task {task_id} failed")
                if remaining:
                    time.sleep(0.05)
            self.assertFalse(remaining, f"unfinished tasks: {len(remaining)}")
        finally:
            q1.stop(); q2.stop()

    def test_sqlite_migration_is_idempotent_and_refuses_target_conflicts(self) -> None:
        suffix = uuid.uuid4().hex[:8]
        nonce = uuid.uuid4().hex
        now = int(time.time())
        schema = "admin_migration_" + uuid.uuid4().hex
        app_user = "admin_runtime_" + suffix
        with psycopg.connect(DSN, autocommit=True) as admin:
            current_user = admin.execute("SELECT current_user").fetchone()[0]
            admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
            admin.execute(sql.SQL("CREATE ROLE {} NOLOGIN").format(sql.Identifier(app_user)))
            admin.execute(
                sql.SQL(
                    "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA {} "
                    "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {}"
                ).format(sql.Identifier(current_user), sql.Identifier(schema), sql.Identifier(app_user))
            )
        test_dsn = make_conninfo(DSN, options=f"-c search_path={schema}")

        def drop_schema() -> None:
            with psycopg.connect(DSN, autocommit=True) as admin:
                admin.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(schema)))
                admin.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(app_user)))

        self.addCleanup(drop_schema)

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "admin.db"
            db = sqlite3.connect(path)
            try:
                db.executescript(
                    """
                    CREATE TABLE feature_flags(name TEXT PRIMARY KEY, enabled INTEGER NOT NULL, description TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL);
                    CREATE TABLE alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, acknowledged_at TEXT, acknowledged_by TEXT);
                    CREATE TABLE analysis_parameter_overrides(domain TEXT NOT NULL,key TEXT NOT NULL,enabled INTEGER NOT NULL,threshold TEXT NOT NULL,label TEXT,source TEXT,value_type TEXT,scale TEXT,description TEXT,custom INTEGER NOT NULL,deleted INTEGER NOT NULL,updated_by TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(domain,key));
                    CREATE TABLE admin_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, username TEXT, ip_address TEXT, action TEXT NOT NULL, resource TEXT, success INTEGER NOT NULL, details_json TEXT);
                    CREATE TABLE revoked_admin_sessions(nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, revoked_at TEXT NOT NULL);
                    """
                )
                db.execute("INSERT INTO feature_flags VALUES(?,?,?,?,?)", (f"migration.{suffix}", 1, "migrated", "admin", "2026-08-16T09:00:00+00:00"))
                db.execute(
                    "INSERT INTO analysis_parameter_overrides VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    ("telegram", f"mig_{suffix}", 1, ">= 1", "Migrated", "metrics.score", "number", "raw", "migrated", 1, 0, "admin", "2026-08-16T09:00:00+00:00"),
                )
                db.execute("INSERT INTO admin_audit(created_at,username,action,success,details_json) VALUES(?,?,?,?,?)", ("2026-08-16T09:00:00+00:00", "admin", f"migration_{suffix}", 1, '{"ok":true}'))
                db.execute("INSERT INTO revoked_admin_sessions VALUES(?,?,?)", (nonce, now + 600, "2026-08-16T09:00:00+00:00"))
                db.commit()
            finally:
                db.close()

            env = os.environ.copy()
            env.update({
                "ADMIN_AUDIT_DB": str(path),
                "ADMIN_STATE_MIGRATOR_DSN": test_dsn,
                "ADMIN_STATE_APP_USER": app_user,
            })
            script = ADMIN_ROOT / "scripts" / "migrate_admin_state_to_postgres.py"
            first = subprocess.run(
                [sys.executable, str(script)], cwd=REPO_ROOT, env=env,
                capture_output=True, text=True, check=True,
            )
            self.assertIn("MIGRATION_OK", first.stdout)

            second = subprocess.run(
                [sys.executable, str(script)], cwd=REPO_ROOT, env=env,
                capture_output=True, text=True, check=True,
            )
            self.assertIn("SKIP admin-sqlite-to-postgres-v1: source fingerprint unchanged", second.stdout)

            # Removing the marker must not turn a stale SQLite snapshot into an
            # overwrite path. The target row remains authoritative on conflict.
            with psycopg.connect(test_dsn) as target:
                target.execute(
                    "DELETE FROM admin_state_migrations WHERE migration_key='admin-sqlite-to-postgres-v1'"
                )
            with sqlite3.connect(path) as source:
                source.execute(
                    "UPDATE feature_flags SET enabled=0,description='stale overwrite' WHERE name=?",
                    (f"migration.{suffix}",),
                )

            conflict = subprocess.run(
                [sys.executable, str(script)], cwd=REPO_ROOT, env=env,
                capture_output=True, text=True,
            )
            self.assertNotEqual(conflict.returncode, 0)
            self.assertIn("PostgreSQL target conflict in feature_flags", conflict.stderr)

        control = PostgresControlStore(test_dsn)
        flag = next(row for row in control.flags() if row["name"] == f"migration.{suffix}")
        self.assertTrue(flag["enabled"])
        self.assertEqual(flag["description"], "migrated")

        profiles = PostgresLiveAnalysisProfileStore(test_dsn)
        self.assertTrue(any(row["key"] == f"mig_{suffix}" for row in profiles.list("telegram")))
        security = PostgresAdminSessionStore(test_dsn, ip_binding=lambda _request: "", ua_binding=lambda _request: "")
        self.assertTrue(security.is_revoked(nonce))

        with psycopg.connect(test_dsn) as target:
            role_exists = target.execute(
                "SELECT 1 FROM pg_roles WHERE rolname=%s", (app_user,)
            ).fetchone()
            if role_exists:
                migration_marker_privileges = target.execute(
                    "SELECT has_table_privilege(%s, 'admin_state_migrations', 'SELECT'), "
                    "has_table_privilege(%s, 'admin_state_migrations', 'INSERT'), "
                    "has_table_privilege(%s, 'admin_state_migrations', 'UPDATE'), "
                    "has_table_privilege(%s, 'admin_state_migrations', 'DELETE')",
                    (app_user, app_user, app_user, app_user),
                ).fetchone()
                self.assertEqual(migration_marker_privileges, (False, False, False, False))
            self.assertEqual(
                target.execute(
                    "SELECT count(*) FROM admin_state_migrations "
                    "WHERE migration_key='admin-sqlite-to-postgres-v1'"
                ).fetchone()[0],
                0,
                "a rejected conflicting migration must not leave a success marker",
            )


class AdminSQLiteSnapshotTests(unittest.TestCase):
    def test_backup_script_captures_committed_wal_pages(self) -> None:
        with tempfile.TemporaryDirectory(prefix="admin-sqlite-snapshot-") as tmp:
            source_path = Path(tmp) / "audit.db"
            source = sqlite3.connect(source_path)
            try:
                source.execute("PRAGMA journal_mode=WAL")
                source.execute("CREATE TABLE audit_rows(id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
                source.execute("INSERT INTO audit_rows VALUES(1,'committed-in-wal')")
                source.commit()
                self.assertTrue(Path(str(source_path) + "-wal").exists())

                env = os.environ.copy()
                env["ADMIN_AUDIT_DB"] = str(source_path)
                script = ADMIN_ROOT / "scripts" / "backup_admin_state_sqlite.py"
                result = subprocess.run(
                    [sys.executable, str(script)],
                    cwd=ADMIN_ROOT,
                    env=env,
                    capture_output=True,
                    check=True,
                )
                self.assertTrue(result.stdout.startswith(b"SQLite format 3"))
                snapshot_path = Path(tmp) / "snapshot.db"
                snapshot_path.write_bytes(result.stdout)
                with sqlite3.connect(snapshot_path) as snapshot:
                    self.assertEqual(
                        snapshot.execute("PRAGMA integrity_check").fetchone()[0],
                        "ok",
                    )
                    self.assertEqual(
                        snapshot.execute("SELECT value FROM audit_rows WHERE id=1").fetchone()[0],
                        "committed-in-wal",
                    )
            finally:
                source.close()


if __name__ == "__main__":
    unittest.main()
