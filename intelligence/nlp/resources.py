"""Laptop-first RAM guard for optional local sentiment inference.

Only the opt-in AI process is throttled: collectors and their databases are
never paused, reniced or modified. This is a cooperative soft budget, not an
OS-enforced cgroup/job-object memory limit. Fail closed on unavailable metrics.
"""
from __future__ import annotations

import math
import os
import sys
import time
from dataclasses import dataclass
from threading import Event
from typing import Callable


class ResourcePressure(RuntimeError):
    """AI work must defer; previously committed batches remain intact."""


@dataclass(frozen=True)
class MemorySample:
    available_mb: float
    ai_rss_mb: float


@dataclass(frozen=True)
class ResourcePolicy:
    # 16 GB laptop; reserve 3 GB for OS + collectors, plus load headroom.
    min_free_mb: int = 3072
    max_ai_rss_mb: int = 3072
    model_reserve_mb: int = 640
    poll_seconds: float = 5.0
    max_wait_seconds: float = 120.0

    def __post_init__(self) -> None:
        if (type(self.min_free_mb) is not int or not 512 <= self.min_free_mb <= 65536
                or type(self.max_ai_rss_mb) is not int
                or not 512 <= self.max_ai_rss_mb <= 65536
                or type(self.model_reserve_mb) is not int
                or not 0 <= self.model_reserve_mb <= 8192):
            raise ValueError("invalid local sentiment memory policy")
        if (not math.isfinite(self.poll_seconds)
                or not 0.1 <= self.poll_seconds <= 60.0
                or not math.isfinite(self.max_wait_seconds)
                or not 0 <= self.max_wait_seconds <= 3600):
            raise ValueError("invalid local sentiment wait policy")

    @classmethod
    def from_environment(cls) -> "ResourcePolicy":
        return cls(
            min_free_mb=int(os.getenv("SENTIMENT_MIN_FREE_RAM_MB", "3072")),
            max_ai_rss_mb=int(os.getenv("SENTIMENT_MAX_AI_RSS_MB", "3072")),
            model_reserve_mb=int(os.getenv("SENTIMENT_MODEL_RESERVE_MB", "640")),
            poll_seconds=float(os.getenv("SENTIMENT_RESOURCE_POLL_SECONDS", "5")),
            max_wait_seconds=float(os.getenv("SENTIMENT_MAX_MEMORY_WAIT_SECONDS", "120")),
        )


def sample_local_memory() -> MemorySample:
    """Native snapshots require optional psutil; no credentials/network."""
    try:
        import psutil
    except ImportError as exc:
        raise ResourcePressure(
            "local memory guard requires the optional sentiment dependencies"
        ) from exc
    return MemorySample(
        available_mb=psutil.virtual_memory().available / (1024 * 1024),
        ai_rss_mb=psutil.Process().memory_info().rss / (1024 * 1024),
    )


def favor_collectors() -> None:
    """Reduce priority of *this AI process only*, never collector processes."""
    try:
        import psutil
    except ImportError as exc:
        raise ResourcePressure("AI low-priority mode requires psutil") from exc
    process = psutil.Process()
    try:
        if sys.platform == "win32":
            process.nice(psutil.IDLE_PRIORITY_CLASS)
        else:
            # Increasing niceness as a regular user is allowed on Linux.
            process.nice(max(int(process.nice()), 10))
    except (OSError, ValueError, AttributeError) as exc:
        # Fail closed: cannot claim collectors are prioritized.
        raise ResourcePressure("could not lower local AI process priority") from exc


class ResourceController:
    """Cooperative bounded backpressure before model allocations/batches."""

    def __init__(
        self, policy: ResourcePolicy | None = None, *,
        stop: Event | None = None,
        sample: Callable[[], MemorySample] | None = None,
        sleep: Callable[[float], object] | None = None,
        monotonic: Callable[[], float] | None = None,
        set_priority: Callable[[], None] | None = None,
    ) -> None:
        self.policy = policy or ResourcePolicy.from_environment()
        self.stop = stop if stop is not None else Event()
        self.sample = sample or sample_local_memory
        self.sleep = sleep or self.stop.wait
        self.monotonic = monotonic or time.monotonic
        self.set_priority = set_priority or favor_collectors
        self._prioritized = False

    def lower_priority(self) -> None:
        if not self._prioritized:
            self.set_priority()
            self._prioritized = True

    def wait_for_capacity(self, *, unload: Callable[[], None] | None = None) -> bool:
        """Return False for graceful stop, raise on resource timeout/errors.

        An optional unload drops resident model allocations when pressure is
        first detected. Re-measure after unload before going to sleep.
        """
        self.lower_priority()
        started = self.monotonic()
        unloaded = False
        while True:
            if self.stop.is_set():
                return False
            current = self.sample()
            if (not math.isfinite(current.available_mb)
                    or not math.isfinite(current.ai_rss_mb)
                    or current.available_mb < 0 or current.ai_rss_mb < 0):
                raise ResourcePressure("could not verify local memory health")
            p = self.policy
            if (current.available_mb >= p.min_free_mb + p.model_reserve_mb
                    and current.ai_rss_mb + p.model_reserve_mb <= p.max_ai_rss_mb):
                return True
            if unload is not None and not unloaded:
                unload()
                unloaded = True
                # Immediately re-sample because a freed model may suffice.
                continue
            elapsed = self.monotonic() - started
            if elapsed >= p.max_wait_seconds:
                raise ResourcePressure(
                    "insufficient laptop RAM for next AI batch; stop and retry later"
                )
            self.sleep(min(p.poll_seconds, p.max_wait_seconds - elapsed))
