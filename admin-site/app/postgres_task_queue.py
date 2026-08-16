from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Callable

import psycopg
from psycopg.rows import dict_row


class TaskState(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(slots=True)
class PostgresTaskRecord:
    id: str
    kind: str
    owner: str
    state: TaskState
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None
    result: Any = None
    error: str | None = None

    def public(self, *, include_result: bool = True) -> dict[str, Any]:
        payload = {
            "id": self.id,
            "kind": self.kind,
            "owner": self.owner,
            "state": self.state.value,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
        }
        if include_result and self.state == TaskState.COMPLETED:
            payload["result"] = self.result
        return payload


class PostgresTaskQueue:
    _SUBMIT_LOCK_ID = 726824731
    _SCHEMA_LOCK_ID = 726824730

    def __init__(
        self,
        dsn: str,
        *,
        workers: int = 2,
        max_queue: int = 1000,
        max_history: int = 5000,
        poll_seconds: float = 0.15,
        lease_seconds: int = 120,
        max_payload_bytes: int = 8 * 1024 * 1024,
    ) -> None:
        if workers < 1 or workers > 16:
            raise ValueError("workers must be between 1 and 16")
        self.dsn = dsn
        self._workers_count = workers
        self._max_queue = max(1, min(max_queue, 100_000))
        self._max_history = max(self._max_queue, min(max_history, 250_000))
        self._poll_seconds = max(0.05, min(poll_seconds, 5.0))
        self._lease_seconds = max(30, min(lease_seconds, 3600))
        self._max_payload_bytes = max(1024, min(max_payload_bytes, 32 * 1024 * 1024))
        self._handlers: dict[str, Callable[[dict[str, Any]], Any]] = {}
        self._threads: list[threading.Thread] = []
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._started = False
        self._instance_id = uuid.uuid4().hex
        self._init_schema()

    def _connect(self):
        return psycopg.connect(self.dsn, row_factory=dict_row, connect_timeout=5)

    def _init_schema(self) -> None:
        with self._connect() as db, db.cursor() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (self._SCHEMA_LOCK_ID,))
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS admin_background_tasks(
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    owner TEXT NOT NULL,
                    state TEXT NOT NULL,
                    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                    result_json JSONB,
                    error TEXT,
                    created_at TIMESTAMPTZ NOT NULL,
                    started_at TIMESTAMPTZ,
                    finished_at TIMESTAMPTZ,
                    lease_owner TEXT,
                    lease_expires_at TIMESTAMPTZ
                )
                """
            )
            cur.execute("CREATE INDEX IF NOT EXISTS ix_admin_tasks_claim ON admin_background_tasks(state, created_at)")
            cur.execute("CREATE INDEX IF NOT EXISTS ix_admin_tasks_owner_created ON admin_background_tasks(owner, created_at DESC)")

    def register_handler(self, kind: str, handler: Callable[[dict[str, Any]], Any]) -> None:
        if not kind.strip():
            raise ValueError("task kind is required")
        self._handlers[kind.strip()] = handler

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            self._stop.clear()
            self._started = True
            self._recover_expired_leases()
            for index in range(self._workers_count):
                thread = threading.Thread(
                    target=self._worker_loop,
                    name=f"admin-pg-task-worker-{index + 1}",
                    daemon=True,
                )
                thread.start()
                self._threads.append(thread)

    def stop(self, *, timeout: float = 5.0) -> None:
        self._stop.set()
        deadline = time.monotonic() + max(0.0, timeout)
        with self._lock:
            threads = list(self._threads)
        for thread in threads:
            thread.join(max(0.0, deadline - time.monotonic()))
        with self._lock:
            self._threads = [thread for thread in threads if thread.is_alive()]
            self._started = bool(self._threads)

    def submit(
        self,
        *,
        kind: str,
        owner: str,
        payload: dict[str, Any] | None = None,
        fn: Callable[[], Any] | None = None,
    ) -> PostgresTaskRecord:
        del fn
        kind = kind.strip()
        owner = owner.strip()
        if not kind or not owner:
            raise ValueError("kind and owner are required")
        if kind not in self._handlers:
            raise RuntimeError("task handler is not registered")
        if not self.ready():
            raise RuntimeError("task queue is not accepting work")
        payload_json = json.dumps(payload or {}, ensure_ascii=False, separators=(",", ":"), default=str)
        if len(payload_json.encode("utf-8")) > self._max_payload_bytes:
            raise RuntimeError("task payload is too large")
        task_id = uuid.uuid4().hex
        now = _utcnow()
        with self._connect() as db, db.cursor() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (self._SUBMIT_LOCK_ID,))
            cur.execute("SELECT COUNT(*) AS n FROM admin_background_tasks WHERE state IN ('queued','running')")
            if int(cur.fetchone()["n"]) >= self._max_queue:
                raise RuntimeError("task queue is full")
            cur.execute(
                """INSERT INTO admin_background_tasks(id,kind,owner,state,payload_json,created_at)
                   VALUES(%s,%s,%s,'queued',%s::jsonb,%s)""",
                (task_id, kind, owner, payload_json, now),
            )
        self._trim_history()
        return PostgresTaskRecord(id=task_id, kind=kind, owner=owner, state=TaskState.QUEUED, created_at=now.isoformat())

    def get(self, task_id: str) -> PostgresTaskRecord | None:
        with self._connect() as db, db.cursor() as cur:
            cur.execute("SELECT * FROM admin_background_tasks WHERE id=%s", (task_id,))
            row = cur.fetchone()
        return self._record(row) if row else None

    def metrics(self) -> dict[str, int | bool]:
        with self._connect() as db, db.cursor() as cur:
            cur.execute("SELECT state, COUNT(*) AS n FROM admin_background_tasks GROUP BY state")
            counts = {str(row["state"]): int(row["n"]) for row in cur.fetchall()}
        with self._lock:
            alive = sum(1 for thread in self._threads if thread.is_alive())
            accepting = self._started and not self._stop.is_set()
        return {
            "accepting": accepting,
            "workers": self._workers_count,
            "workers_alive": alive,
            "queue_depth": counts.get("queued", 0),
            "queue_capacity": self._max_queue,
            "queued": counts.get("queued", 0),
            "running": counts.get("running", 0),
            "completed": counts.get("completed", 0),
            "failed": counts.get("failed", 0),
        }

    def ready(self) -> bool:
        with self._lock:
            local_ready = self._started and not self._stop.is_set() and sum(t.is_alive() for t in self._threads) == self._workers_count
        if not local_ready:
            return False
        try:
            with self._connect() as db, db.cursor() as cur:
                cur.execute("SELECT 1")
                return cur.fetchone() is not None
        except psycopg.Error:
            return False

    def _recover_expired_leases(self) -> None:
        with self._connect() as db, db.cursor() as cur:
            cur.execute(
                """UPDATE admin_background_tasks
                   SET state='queued', lease_owner=NULL, lease_expires_at=NULL, started_at=NULL
                   WHERE state='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now()"""
            )

    def _claim_one(self) -> dict[str, Any] | None:
        lease_token = f"{self._instance_id}:{uuid.uuid4().hex}"
        lease_until = _utcnow() + timedelta(seconds=self._lease_seconds)
        with self._connect() as db, db.cursor() as cur:
            cur.execute(
                """UPDATE admin_background_tasks
                   SET state='queued', lease_owner=NULL, lease_expires_at=NULL, started_at=NULL
                   WHERE state='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now()"""
            )
            cur.execute(
                """SELECT id FROM admin_background_tasks
                   WHERE state='queued' ORDER BY created_at
                   FOR UPDATE SKIP LOCKED LIMIT 1"""
            )
            row = cur.fetchone()
            if not row:
                return None
            cur.execute(
                """UPDATE admin_background_tasks
                   SET state='running', started_at=COALESCE(started_at, now()),
                       lease_owner=%s, lease_expires_at=%s
                   WHERE id=%s RETURNING *""",
                (lease_token, lease_until, row["id"]),
            )
            return cur.fetchone()

    def _heartbeat_loop(self, task_id: str, lease_token: str, done: threading.Event) -> None:
        interval = max(5.0, self._lease_seconds / 3.0)
        while not done.wait(interval):
            try:
                with self._connect() as db, db.cursor() as cur:
                    cur.execute(
                        """UPDATE admin_background_tasks SET lease_expires_at=%s
                           WHERE id=%s AND state='running' AND lease_owner=%s""",
                        (_utcnow() + timedelta(seconds=self._lease_seconds), task_id, lease_token),
                    )
                    if cur.rowcount != 1:
                        return
            except psycopg.Error:
                continue

    def _finish(self, task_id: str, lease_token: str, *, result: Any = None, failed: bool = False) -> None:
        with self._connect() as db, db.cursor() as cur:
            if failed:
                cur.execute(
                    """UPDATE admin_background_tasks
                       SET state='failed', error='task_failed', finished_at=now(),
                           lease_owner=NULL, lease_expires_at=NULL
                       WHERE id=%s AND lease_owner=%s""",
                    (task_id, lease_token),
                )
            else:
                cur.execute(
                    """UPDATE admin_background_tasks
                       SET state='completed', result_json=%s::jsonb, error=NULL, finished_at=now(),
                           lease_owner=NULL, lease_expires_at=NULL
                       WHERE id=%s AND lease_owner=%s""",
                    (json.dumps(result, ensure_ascii=False, default=str), task_id, lease_token),
                )

    def _worker_loop(self) -> None:
        while not self._stop.is_set():
            try:
                row = self._claim_one()
            except psycopg.Error:
                self._stop.wait(self._poll_seconds)
                continue
            if row is None:
                self._stop.wait(self._poll_seconds)
                continue
            task_id = str(row["id"])
            lease_token = str(row["lease_owner"])
            handler = self._handlers.get(str(row["kind"]))
            if handler is None:
                self._finish(task_id, lease_token, failed=True)
                continue
            payload = row.get("payload_json") or {}
            done = threading.Event()
            heartbeat = threading.Thread(
                target=self._heartbeat_loop,
                args=(task_id, lease_token, done),
                name=f"admin-pg-task-heartbeat-{task_id[:8]}",
                daemon=True,
            )
            heartbeat.start()
            try:
                result = handler(payload if isinstance(payload, dict) else json.loads(payload))
            except Exception:
                self._finish(task_id, lease_token, failed=True)
            else:
                self._finish(task_id, lease_token, result=result)
            finally:
                done.set()
                heartbeat.join(timeout=1.0)

    def _trim_history(self) -> None:
        with self._connect() as db, db.cursor() as cur:
            cur.execute(
                """DELETE FROM admin_background_tasks WHERE id IN (
                     SELECT id FROM admin_background_tasks
                     WHERE state IN ('completed','failed')
                     ORDER BY finished_at DESC NULLS LAST
                     OFFSET %s
                   )""",
                (self._max_history,),
            )

    @staticmethod
    def _record(row: dict[str, Any]) -> PostgresTaskRecord:
        return PostgresTaskRecord(
            id=str(row["id"]),
            kind=str(row["kind"]),
            owner=str(row["owner"]),
            state=TaskState(str(row["state"])),
            created_at=row["created_at"].isoformat() if row.get("created_at") else "",
            started_at=row["started_at"].isoformat() if row.get("started_at") else None,
            finished_at=row["finished_at"].isoformat() if row.get("finished_at") else None,
            result=row.get("result_json"),
            error=row.get("error"),
        )
