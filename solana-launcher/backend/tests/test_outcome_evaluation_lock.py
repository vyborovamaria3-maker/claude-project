from __future__ import annotations

from app.services.outcome_evaluation_lock import (
    OUTCOME_EVALUATION_LOCK_KEY,
    acquire_outcome_write_lock,
    outcome_write_lock_key,
    try_acquire_outcome_evaluation_lock,
)


class _Dialect:
    def __init__(self, name: str) -> None:
        self.name = name


class _Bind:
    def __init__(self, dialect_name: str) -> None:
        self.dialect = _Dialect(dialect_name)


class FakeSession:
    def __init__(self, dialect_name: str, acquired: bool = True) -> None:
        self.bind = _Bind(dialect_name)
        self.acquired = acquired
        self.scalar_calls = 0
        self.execute_calls = 0
        self.params = None

    def get_bind(self):
        return self.bind

    async def scalar(self, statement, params=None):
        del statement
        self.scalar_calls += 1
        self.params = params
        return self.acquired

    async def execute(self, statement, params=None):
        del statement
        self.execute_calls += 1
        self.params = params
        return None


async def test_non_postgres_outcome_lock_is_noop() -> None:
    session = FakeSession("sqlite")
    assert await try_acquire_outcome_evaluation_lock(session) is True
    await acquire_outcome_write_lock(
        session,
        snapshot_id="snapshot-1",
        horizon_hours=72,
    )
    assert session.scalar_calls == 0
    assert session.execute_calls == 0


async def test_postgres_outcome_lock_uses_one_stable_advisory_key() -> None:
    session = FakeSession("postgresql", acquired=False)
    assert await try_acquire_outcome_evaluation_lock(session) is False
    assert session.scalar_calls == 1
    assert session.params == {"lock_key": OUTCOME_EVALUATION_LOCK_KEY}
    assert -(2**63) <= OUTCOME_EVALUATION_LOCK_KEY < 2**63


async def test_postgres_per_outcome_lock_is_scoped_to_snapshot_and_horizon() -> None:
    session = FakeSession("postgresql")
    first = outcome_write_lock_key("snapshot-1", 72)
    same = outcome_write_lock_key("snapshot-1", 72)
    other_snapshot = outcome_write_lock_key("snapshot-2", 72)
    other_horizon = outcome_write_lock_key("snapshot-1", 24)

    assert first == same
    assert first != other_snapshot
    assert first != other_horizon
    assert -(2**63) <= first < 2**63

    await acquire_outcome_write_lock(
        session,
        snapshot_id="snapshot-1",
        horizon_hours=72,
    )
    assert session.execute_calls == 1
    assert session.params == {"lock_key": first}
