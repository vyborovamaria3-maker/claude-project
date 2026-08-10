"""Retry policy primitives for intelligence jobs."""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    max_attempts: int = 3
    backoff_seconds: tuple[int, ...] = (5, 30, 120)

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be >= 1")
        if not self.backoff_seconds:
            raise ValueError("backoff_seconds must not be empty")
        if any(delay < 0 for delay in self.backoff_seconds):
            raise ValueError("backoff delays must be >= 0")

    def delay_for(self, attempt: int) -> int:
        if attempt < 0:
            raise ValueError("attempt must be >= 0")
        if attempt >= len(self.backoff_seconds):
            return self.backoff_seconds[-1]
        return self.backoff_seconds[attempt]

    def can_retry(self, attempts: int) -> bool:
        if attempts < 0:
            raise ValueError("attempts must be >= 0")
        return attempts < self.max_attempts
