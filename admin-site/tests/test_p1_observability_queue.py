from __future__ import annotations

import sys
import threading
import time
import unittest
from pathlib import Path

ADMIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADMIN_ROOT))

from app.observability import Observability
from app.task_queue import AdminTaskQueue, TaskState


class AdminTaskQueueTests(unittest.TestCase):
    def test_completed_task_returns_result_and_metrics(self) -> None:
        queue = AdminTaskQueue(workers=1, max_queue=2, max_history=4)
        queue.start()
        try:
            task = queue.submit(kind="backtest", owner="admin", fn=lambda: {"score": 42})
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                current = queue.get(task.id)
                if current is not None and current.state == TaskState.COMPLETED:
                    break
                time.sleep(0.01)
            current = queue.get(task.id)
            self.assertIsNotNone(current)
            assert current is not None
            self.assertEqual(current.state, TaskState.COMPLETED)
            self.assertEqual(current.result, {"score": 42})
            metrics = queue.metrics()
            self.assertEqual(metrics["completed"], 1)
            self.assertTrue(metrics["accepting"])
            self.assertTrue(queue.ready())
        finally:
            queue.stop()

    def test_failure_is_sanitized(self) -> None:
        queue = AdminTaskQueue(workers=1, max_queue=1, max_history=2)
        queue.start()
        try:
            def fail():
                raise RuntimeError("token=super-secret")

            task = queue.submit(kind="backtest", owner="admin", fn=fail)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                current = queue.get(task.id)
                if current is not None and current.state == TaskState.FAILED:
                    break
                time.sleep(0.01)
            current = queue.get(task.id)
            self.assertIsNotNone(current)
            assert current is not None
            self.assertEqual(current.error, "task_failed")
            self.assertNotIn("super-secret", str(current.public()))
        finally:
            queue.stop()

    def test_queue_backpressure_rejects_excess_work(self) -> None:
        gate = threading.Event()
        queue = AdminTaskQueue(workers=1, max_queue=1, max_history=3)
        queue.start()
        try:
            first = queue.submit(kind="slow", owner="admin", fn=lambda: gate.wait(1))
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                current = queue.get(first.id)
                if current is not None and current.state == TaskState.RUNNING:
                    break
                time.sleep(0.01)
            queue.submit(kind="queued", owner="admin", fn=lambda: True)
            with self.assertRaisesRegex(RuntimeError, "full"):
                queue.submit(kind="overflow", owner="admin", fn=lambda: True)
        finally:
            gate.set()
            queue.stop()

    def test_start_submit_stop_is_stable_for_100_iterations(self) -> None:
        for iteration in range(100):
            with self.subTest(iteration=iteration):
                queue = AdminTaskQueue(workers=1, max_queue=1, max_history=2)
                queue.start()
                task = queue.submit(kind="stress", owner="admin", fn=lambda: True)
                deadline = time.monotonic() + 1
                while time.monotonic() < deadline:
                    current = queue.get(task.id)
                    if current is not None and current.state == TaskState.COMPLETED:
                        break
                    time.sleep(0.001)
                queue.stop(timeout=1.0)
                self.assertFalse(queue.metrics()["accepting"])
                self.assertEqual(queue.metrics()["workers_alive"], 0)


class ObservabilityTests(unittest.TestCase):
    def test_prometheus_metrics_are_bounded_and_include_queue(self) -> None:
        obs = Observability(service_name="POTAPoff", environment="test")
        obs.record_request(method="GET", path="/api/analysis-tasks/a" * 20, status_code=200, duration_seconds=0.02)
        payload = obs.render_prometheus(
            queue_metrics=lambda: {
                "queue_depth": 2,
                "workers_alive": 1,
                "queued": 2,
                "running": 1,
                "completed": 3,
                "failed": 4,
            }
        )
        self.assertIn("potapoff_admin_http_requests_total", payload)
        self.assertIn("potapoff_admin_task_queue_depth 2", payload)
        self.assertIn('potapoff_admin_tasks{state="failed"} 4', payload)
        self.assertLess(len(payload), 20_000)

    def test_prometheus_labels_escape_untrusted_text(self) -> None:
        obs = Observability(service_name="POTAPoff", environment="test")
        obs.record_request(method='GE"T', path='/api/x\nvalue', status_code=500, duration_seconds=0.1)
        payload = obs.render_prometheus()
        self.assertNotIn('method="GE"T"', payload)
        self.assertIn('method="GE\\"T"', payload)
        self.assertIn('path="/api/x\\nvalue"', payload)


if __name__ == "__main__":
    unittest.main()
