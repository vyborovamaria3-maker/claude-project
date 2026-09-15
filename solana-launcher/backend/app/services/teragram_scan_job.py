from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
from collections import deque
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.services.teragram_invite_source import teragram_output_dir

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
_MEMORY_LIMIT_RE = re.compile(r"^[1-9][0-9]*(?:MB|GB|TB)$", re.IGNORECASE)
_ALLOWED_SIGNAL_SOURCES = {"auto", "content", "entities", "metadata"}


def _utcnow_iso() -> str:
    return datetime.now(UTC).isoformat()


def _resolve_server_path(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = _BACKEND_ROOT / path
    return path.resolve()


def _configured_input_dir() -> Path:
    configured = (os.getenv("TG_TERAGRAM_INPUT_DIR") or "").strip()
    if not configured:
        raise ValueError("TG_TERAGRAM_INPUT_DIR is not configured on the backend")

    path = _resolve_server_path(configured)
    if not path.is_dir():
        raise FileNotFoundError(f"TeraGram input directory does not exist: {path}")
    return path


def _progress_for_line(line: str) -> tuple[int | None, str | None]:
    value = line.lower()

    if "discovering csv/parquet relations" in value:
        return 10, "discovering"
    if "signal source =" in value:
        return 25, "signal_source"
    if "building disk-backed candidate" in value:
        return 45, "prefilter"
    if "applying exact potapoff" in value:
        return 70, "scoring"
    if "teragram: done;" in value:
        return 100, "completed"

    return None, None


def _build_scan_command(
    *,
    input_dir: Path,
    output_dir: Path,
    mode: str,
    max_chats: int | None,
    seed_limit: int,
    signal_source: str,
    threads: int | None,
    memory_limit: str,
    fetch_size: int,
) -> tuple[list[str], dict[str, Any]]:
    normalized_mode = mode.strip().lower()
    if normalized_mode not in {"preview", "full"}:
        raise ValueError("mode must be preview or full")

    if seed_limit < 1:
        raise ValueError("seed_limit must be positive")

    if max_chats is not None and max_chats < 1:
        raise ValueError("max_chats must be positive")

    if threads is not None and threads < 1:
        raise ValueError("threads must be positive")

    if fetch_size < 1:
        raise ValueError("fetch_size must be positive")

    normalized_memory = memory_limit.strip().upper()
    if not _MEMORY_LIMIT_RE.fullmatch(normalized_memory):
        raise ValueError("memory_limit must look like 512MB, 4GB, or 16GB")

    normalized_signal = signal_source.strip().lower()
    if normalized_signal not in _ALLOWED_SIGNAL_SOURCES:
        raise ValueError("signal_source must be auto, content, entities, or metadata")

    effective_max_chats = max_chats
    if normalized_mode == "preview" and effective_max_chats is None:
        effective_max_chats = 1000

    command = [
        sys.executable,
        "-m",
        "app.cli.teragram_filter",
        "--input-dir",
        str(input_dir),
        "--output",
        str(output_dir),
        "--seed-limit",
        str(seed_limit),
        "--signal-source",
        normalized_signal,
        "--memory-limit",
        normalized_memory,
        "--fetch-size",
        str(fetch_size),
    ]

    if effective_max_chats is not None:
        command.extend(["--max-chats", str(effective_max_chats)])

    if threads is not None:
        command.extend(["--threads", str(threads)])

    config = {
        "mode": normalized_mode,
        "input_dir": str(input_dir),
        "output_dir": str(output_dir),
        "max_chats": effective_max_chats,
        "seed_limit": seed_limit,
        "signal_source": normalized_signal,
        "threads": threads,
        "memory_limit": normalized_memory,
        "fetch_size": fetch_size,
    }

    return command, config


class TeraGramScanJobManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._process: subprocess.Popen[str] | None = None
        self._watcher: threading.Thread | None = None
        self._stop_requested = False
        self._logs: deque[str] = deque(maxlen=100)
        self._state: dict[str, Any] = {
            "job_id": None,
            "status": "idle",
            "pid": None,
            "progress_percent": 0,
            "stage": "idle",
            "started_at": None,
            "finished_at": None,
            "last_line": None,
            "error": None,
            "config": None,
            "summary": None,
        }

    def _snapshot_locked(self) -> dict[str, Any]:
        result = dict(self._state)
        result["logs"] = list(self._logs)
        return result

    def _persist_locked(self, output: Path) -> None:
        try:
            output.mkdir(parents=True, exist_ok=True)
            target = output / "scan_job_status.json"
            temporary = output / "scan_job_status.json.tmp"
            temporary.write_text(
                json.dumps(
                    self._snapshot_locked(),
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            os.replace(temporary, target)
        except OSError:
            pass

    @staticmethod
    def _load_summary(output: Path) -> dict[str, Any] | None:
        path = output / "summary.json"
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def status(self) -> dict[str, Any]:
        with self._lock:
            return self._snapshot_locked()

    def start(
        self,
        *,
        mode: str = "preview",
        max_chats: int | None = None,
        seed_limit: int = 250,
        signal_source: str = "auto",
        threads: int | None = None,
        memory_limit: str = "4GB",
        fetch_size: int = 10_000,
    ) -> dict[str, Any]:
        input_dir = _configured_input_dir()
        output = teragram_output_dir()

        command, config = _build_scan_command(
            input_dir=input_dir,
            output_dir=output,
            mode=mode,
            max_chats=max_chats,
            seed_limit=seed_limit,
            signal_source=signal_source,
            threads=threads,
            memory_limit=memory_limit,
            fetch_size=fetch_size,
        )

        with self._lock:
            if self._process is not None:
                raise RuntimeError("A TeraGram scan is already running or finalizing")

            job_id = uuid4().hex
            self._stop_requested = False
            self._logs.clear()

            self._state = {
                "job_id": job_id,
                "status": "starting",
                "pid": None,
                "progress_percent": 0,
                "stage": "starting",
                "started_at": _utcnow_iso(),
                "finished_at": None,
                "last_line": None,
                "error": None,
                "config": config,
                "summary": None,
            }

            try:
                process = subprocess.Popen(
                    command,
                    cwd=str(_BACKEND_ROOT),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                )
            except Exception as exc:
                self._state.update(
                    {
                        "status": "failed",
                        "stage": "failed",
                        "finished_at": _utcnow_iso(),
                        "error": str(exc),
                    }
                )
                self._persist_locked(output)
                raise

            self._process = process
            self._state["pid"] = process.pid
            self._state["status"] = "running"
            self._state["stage"] = "starting"
            self._persist_locked(output)

            watcher = threading.Thread(
                target=self._watch_process,
                args=(process, output),
                name=f"teragram-scan-{job_id[:8]}",
                daemon=True,
            )
            self._watcher = watcher
            watcher.start()

            return self._snapshot_locked()

    def _watch_process(
        self,
        process: subprocess.Popen[str],
        output: Path,
    ) -> None:
        stdout = process.stdout

        if stdout is not None:
            for raw_line in stdout:
                line = raw_line.rstrip("\r\n")
                if not line:
                    continue

                progress, stage = _progress_for_line(line)

                with self._lock:
                    if self._process is not process:
                        continue

                    self._logs.append(line)
                    self._state["last_line"] = line

                    if progress is not None:
                        self._state["progress_percent"] = progress
                    if stage is not None:
                        self._state["stage"] = stage

                    self._persist_locked(output)

        return_code = process.wait()

        with self._lock:
            if self._process is not process:
                return

            stopped = self._stop_requested
            summary = self._load_summary(output) if return_code == 0 else None

            if return_code == 0 and not stopped:
                self._state.update(
                    {
                        "status": "succeeded",
                        "stage": "completed",
                        "progress_percent": 100,
                        "summary": summary,
                        "error": None,
                    }
                )
            elif stopped:
                self._state.update(
                    {
                        "status": "stopped",
                        "stage": "stopped",
                        "error": None,
                    }
                )
            else:
                self._state.update(
                    {
                        "status": "failed",
                        "stage": "failed",
                        "error": (
                            self._state.get("last_line")
                            or f"TeraGram scanner exited with code {return_code}"
                        ),
                    }
                )

            self._state["finished_at"] = _utcnow_iso()
            self._state["pid"] = None
            self._persist_locked(output)

            self._process = None
            self._watcher = None
            self._stop_requested = False

    def stop(self) -> dict[str, Any]:
        output = teragram_output_dir()

        with self._lock:
            process = self._process
            if process is None or process.poll() is not None:
                raise RuntimeError("No active TeraGram scan to stop")

            self._stop_requested = True
            self._state["status"] = "stopping"
            self._state["stage"] = "stopping"
            self._logs.append("Stop requested by administrator")
            self._state["last_line"] = "Stop requested by administrator"

            try:
                process.terminate()
            except OSError as exc:
                self._state["error"] = str(exc)
                self._persist_locked(output)
                raise RuntimeError("Failed to terminate TeraGram scanner") from exc

            self._persist_locked(output)
            return self._snapshot_locked()


teragram_scan_manager = TeraGramScanJobManager()
