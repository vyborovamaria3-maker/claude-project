"""Regression coverage for concurrent insertion of an owner's Telegram session."""

from __future__ import annotations

import base64
from types import SimpleNamespace
from uuid import uuid4

import pytest
from app.api.v1.tginvite_vault import StoredTelegramSession, store_session
from app.services.telegram_invite_vault import decrypt_session
from fastapi import Request
from sqlalchemy.exc import IntegrityError

KEY = base64.b64encode(b"z" * 32).decode("ascii")


class _Result:
    def __init__(self, row):
        self.row = row

    def scalar_one_or_none(self):
        return self.row


class _CompetingInsertSession:
    def __init__(self):
        self.selects = 0
        self.commits = 0
        self.rolled_back = False
        self.winner = SimpleNamespace(encrypted_payload="older-competing-value")

    async def execute(self, _query):
        self.selects += 1
        return _Result(None if self.selects == 1 else self.winner)

    def add(self, _row):
        pass

    async def commit(self):
        self.commits += 1
        if self.commits == 1:
            raise IntegrityError(
                "INSERT telegram_invite_sessions", {}, RuntimeError("unique owner_id")
            )

    async def rollback(self):
        self.rolled_back = True


@pytest.mark.asyncio
async def test_vault_recovers_when_another_worker_inserts_owner_first(test_app):
    owner_id = str(uuid4())
    test_app.state.settings.tginvite_session_encryption_key = KEY
    request = Request({"type": "http", "app": test_app})
    db = _CompetingInsertSession()
    session = StoredTelegramSession(
        api_id=12345, api_hash="a" * 32, session_string="test.session.key.012345"
    )

    response = await store_session(
        session, request, owner=SimpleNamespace(id=owner_id), db=db
    )

    assert response.status_code == 204
    assert db.rolled_back is True
    assert db.commits == 2
    assert decrypt_session(owner_id, db.winner.encrypted_payload, KEY) == session.model_dump()
