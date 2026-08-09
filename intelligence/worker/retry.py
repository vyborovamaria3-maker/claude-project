"""Retry policy primitives for intelligence jobs."""

from dataclasses import dataclass


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 3
    backoff_seconds: tuple[int, ...] = (5, 30, 120)

    def delay_for(self, attempt: int) -> int:
        if attempt < 0:
            return self.backoff_seconds[0]
        if attempt >= len(self.backoff_seconds):
            return self.backoff_seconds[-1]
        return self.backoff_seconds[attempt]

    def can_retry(self, attempts: int) -> bool:
        return attempts < self.max_attempts
