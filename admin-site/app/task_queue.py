from __future__ import annotations

import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable


class TaskState(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass(slots=True)
class TaskRecord:
    id: str
    kind: str
    owner: str
    state: TaskState = TaskState.QUEUED
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
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


@dataclass(slots=True)
class _WorkItem:
    task_id: str
    fn: Callable[[], Any]


class AdminTaskQueue:
    def __init__(self, *, workers: int = 2, max_queue: int = 32, max_history: int = 500) -> None:
        if workers < 1 or workers > 16:
            raise ValueError("workers must be between 1 and 16")
        if max_queue < 1 or max_queue > 10_000:
            raise ValueError("max_queue must be between 1 and 10000")
        if max_history < max_queue or max_history > 50_000:
            raise ValueError("max_history must be >= max_queue and <= 50000")
        self._queue: queue.Queue[_WorkItem | None] = queue.Queue(maxsize=max_queue)
        self._workers_count = workers
        self._max_history = max_history
        self._records: dict[str, TaskRecord] = {}
        self._order: list[str] = []
        self._lock = threading.RLock()
        self._threads: list[threading.Thread] = []
        self._started = False
        self._stopping = False
        self._handlers: dict[str, Callable[[dict[str, Any]], Any]] = {}

    def register_handler(self, kind: str, handler: Callable[[dict[str, Any]], Any]) -> None:
        self._handlers[kind.strip()] = handler

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            self._started = True
            self._stopping = False
            for index in range(self._workers_count):
                thread = threading.Thread(target=self._worker_loop, name=f"admin-task-worker-{index + 1}", daemon=True)
                thread.start()
                self._threads.append(thread)

    def stop(self, *, timeout: float = 5.0) -> None:
        with self._lock:
            if not self._started:
                return
            self._stopping = True
            threads = list(self._threads)
        deadline = time.monotonic() + max(0.0, timeout)
        for _ in threads:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                self._queue.put(None, timeout=remaining)
            except queue.Full:
                break
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
        fn: Callable[[], Any] | None = None,
        payload: dict[str, Any] | None = None,
    ) -> TaskRecord:
        if not kind.strip() or not owner.strip():
            raise ValueError("kind and owner are required")
        if fn is None:
            handler = self._handlers.get(kind.strip())
            if handler is None:
                raise RuntimeError("task handler is not registered")
            task_payload = dict(payload or {})
            fn = lambda: handler(task_payload)
        with self._lock:
            if not self._started or self._stopping:
                raise RuntimeError("task queue is not accepting work")
            task_id = uuid.uuid4().hex
            record = TaskRecord(id=task_id, kind=kind.strip()[:80], owner=owner.strip()[:255])
            self._records[task_id] = record
            self._order.append(task_id)
            self._trim_history_locked()
        try:
            self._queue.put_nowait(_WorkItem(task_id=task_id, fn=fn))
        except queue.Full:
            with self._lock:
                self._records.pop(task_id, None)
                if task_id in self._order:
                    self._order.remove(task_id)
            raise RuntimeError("task queue is full") from None
        return record

    def get(self, task_id: str) -> TaskRecord | None:
        with self._lock:
            return self._records.get(task_id)

    def metrics(self) -> dict[str, int | bool]:
        with self._lock:
            states = {state.value: 0 for state in TaskState}
            for record in self._records.values():
                states[record.state.value] += 1
            return {
                "accepting": self._started and not self._stopping,
                "workers": self._workers_count,
                "workers_alive": sum(1 for thread in self._threads if thread.is_alive()),
                "queue_depth": self._queue.qsize(),
                "queue_capacity": self._queue.maxsize,
                **states,
            }

    def ready(self) -> bool:
        metrics = self.metrics()
        return bool(metrics["accepting"]) and int(metrics["workers_alive"]) == self._workers_count

    def _worker_loop(self) -> None:
        while True:
            item = self._queue.get()
            try:
                if item is None:
                    return
                with self._lock:
                    record = self._records.get(item.task_id)
                    if record is None:
                        continue
                    record.state = TaskState.RUNNING
                    record.started_at = datetime.now(timezone.utc).isoformat()
                try:
                    result = item.fn()
                except Exception:
                    with self._lock:
                        record = self._records.get(item.task_id)
                        if record is not None:
                            record.state = TaskState.FAILED
                            record.error = "task_failed"
                            record.finished_at = datetime.now(timezone.utc).isoformat()
                else:
                    with self._lock:
                        record = self._records.get(item.task_id)
                        if record is not None:
                            record.state = TaskState.COMPLETED
                            record.result = result
                            record.finished_at = datetime.now(timezone.utc).isoformat()
            finally:
                self._queue.task_done()

    def _trim_history_locked(self) -> None:
        if len(self._order) <= self._max_history:
            return
        retained: list[str] = []
        removable = len(self._order) - self._max_history
        for task_id in self._order:
            record = self._records.get(task_id)
            if removable > 0 and record is not None and record.state in {TaskState.COMPLETED, TaskState.FAILED}:
                self._records.pop(task_id, None)
                removable -= 1
            else:
                retained.append(task_id)
        self._order = retained
