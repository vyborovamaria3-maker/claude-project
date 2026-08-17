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

ADMIN_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ADMIN_ROOT.parent
sys.path.insert(0, str(ADMIN_ROOT))

from app.postgres_admin_state import PostgresAuditStore, PostgresControlStore, PostgresLiveAnalysisProfileStore
from app.postgres_security_store import PostgresAdminSessionStore
from app.postgres_task_queue import PostgresTaskQueue, TaskState


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

    def test_sqlite_migration_is_idempotent_and_preserves_revocations(self) -> None:
        suffix = uuid.uuid4().hex[:8]
        nonce = uuid.uuid4().hex
        now = int(time.time())
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
            env.update({"ADMIN_AUDIT_DB": str(path), "ADMIN_STATE_POSTGRES_DSN": DSN})
            script = ADMIN_ROOT / "scripts" / "migrate_admin_state_to_postgres.py"
            first = subprocess.run([sys.executable, str(script)], cwd=REPO_ROOT, env=env, capture_output=True, text=True, check=True)
            second = subprocess.run([sys.executable, str(script)], cwd=REPO_ROOT, env=env, capture_output=True, text=True, check=True)
            self.assertIn("MIGRATION_OK", first.stdout)
            self.assertIn("already applied", second.stdout)

        control = PostgresControlStore(DSN)
        self.assertTrue(any(row["name"] == f"migration.{suffix}" and row["enabled"] for row in control.flags()))
        profiles = PostgresLiveAnalysisProfileStore(DSN)
        self.assertTrue(any(row["key"] == f"mig_{suffix}" for row in profiles.list("telegram")))
        security = PostgresAdminSessionStore(DSN, ip_binding=lambda _request: "", ua_binding=lambda _request: "")
        self.assertTrue(security.is_revoked(nonce))


if __name__ == "__main__":
    unittest.main()
