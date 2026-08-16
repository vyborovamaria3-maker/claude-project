from __future__ import annotations

import hmac
import time
from datetime import datetime, timezone
from typing import Any, Callable

import psycopg
from fastapi import HTTPException
from psycopg.rows import dict_row


_SCHEMA_LOCK_ID = 726824730


class PostgresAdminSessionStore:
    def __init__(
        self,
        dsn: str,
        *,
        ip_binding: Callable[[Any], str],
        ua_binding: Callable[[Any], str],
    ) -> None:
        self.dsn = dsn
        self._ip_binding = ip_binding
        self._ua_binding = ua_binding
        self._init_schema()

    def _connect(self):
        return psycopg.connect(self.dsn, row_factory=dict_row, connect_timeout=5)

    def _init_schema(self) -> None:
        now = int(time.time())
        with self._connect() as db, db.cursor() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (_SCHEMA_LOCK_ID,))
            cur.execute(
                """CREATE TABLE IF NOT EXISTS admin_security_sessions(
                    nonce TEXT PRIMARY KEY,
                    username TEXT NOT NULL,
                    issued_at BIGINT NOT NULL,
                    expires_at BIGINT NOT NULL,
                    last_seen_at BIGINT NOT NULL,
                    mfa_verified_at BIGINT,
                    reauth_until BIGINT,
                    ip_hash TEXT,
                    user_agent_hash TEXT
                )"""
            )
            cur.execute("CREATE INDEX IF NOT EXISTS ix_admin_security_sessions_expires ON admin_security_sessions(expires_at)")
            cur.execute(
                """CREATE TABLE IF NOT EXISTS revoked_admin_sessions(
                    nonce TEXT PRIMARY KEY,
                    expires_at BIGINT NOT NULL,
                    revoked_at TIMESTAMPTZ NOT NULL
                )"""
            )
            cur.execute("CREATE INDEX IF NOT EXISTS ix_revoked_admin_sessions_expires ON revoked_admin_sessions(expires_at)")
            cur.execute("DELETE FROM admin_security_sessions WHERE expires_at<=%s", (now,))
            cur.execute("DELETE FROM revoked_admin_sessions WHERE expires_at<=%s", (now,))

    def is_revoked(self, nonce: str) -> bool:
        if not nonce:
            return True
        now = int(time.time())
        with self._connect() as db, db.cursor() as cur:
            cur.execute("SELECT 1 FROM revoked_admin_sessions WHERE nonce=%s AND expires_at>%s LIMIT 1", (nonce, now))
            return cur.fetchone() is not None

    def revoke(self, nonce: str, expires_at: int) -> None:
        now = int(time.time())
        if not nonce or expires_at <= now:
            return
        with self._connect() as db, db.cursor() as cur:
            cur.execute("DELETE FROM revoked_admin_sessions WHERE expires_at<=%s", (now,))
            cur.execute("DELETE FROM admin_security_sessions WHERE expires_at<=%s", (now,))
            cur.execute(
                """INSERT INTO revoked_admin_sessions(nonce,expires_at,revoked_at)
                   VALUES(%s,%s,%s)
                   ON CONFLICT(nonce) DO UPDATE SET expires_at=EXCLUDED.expires_at, revoked_at=EXCLUDED.revoked_at""",
                (nonce, int(expires_at), datetime.now(timezone.utc)),
            )

    def _insert_session(self, payload: dict[str, Any], request: Any, policy: Any, now: int) -> dict[str, Any]:
        nonce = str(payload["nonce"])
        with self._connect() as db, db.cursor() as cur:
            cur.execute(
                """INSERT INTO admin_security_sessions(
                     nonce,username,issued_at,expires_at,last_seen_at,mfa_verified_at,reauth_until,ip_hash,user_agent_hash
                   ) VALUES(%s,%s,%s,%s,%s,NULL,NULL,%s,%s)
                   ON CONFLICT(nonce) DO NOTHING""",
                (
                    nonce,
                    str(payload["sub"]),
                    int(payload["iat"]),
                    int(payload["exp"]),
                    now,
                    self._ip_binding(request) if policy.bind_ip else None,
                    self._ua_binding(request) if policy.bind_user_agent else None,
                ),
            )
            cur.execute("SELECT * FROM admin_security_sessions WHERE nonce=%s", (nonce,))
            return dict(cur.fetchone())

    def get_or_create(self, payload: dict[str, Any], request: Any, policy: Any) -> dict[str, Any]:
        now = int(time.time())
        nonce = str(payload["nonce"])
        with self._connect() as db, db.cursor() as cur:
            cur.execute("SELECT * FROM admin_security_sessions WHERE nonce=%s", (nonce,))
            row = cur.fetchone()
        return dict(row) if row else self._insert_session(payload, request, policy, now)

    def validate_and_touch(self, payload: dict[str, Any], request: Any, policy: Any) -> dict[str, Any]:
        now = int(time.time())
        nonce = str(payload["nonce"])
        with self._connect() as db, db.cursor() as cur:
            cur.execute("SELECT * FROM admin_security_sessions WHERE nonce=%s", (nonce,))
            row = cur.fetchone()
            if row is None:
                return self._insert_session(payload, request, policy, now)
            item = dict(row)
            if now - int(item["last_seen_at"]) > policy.idle_timeout_seconds:
                raise HTTPException(status_code=401, detail="Admin session expired due to inactivity")
            if policy.bind_ip and item.get("ip_hash") and not hmac.compare_digest(item["ip_hash"], self._ip_binding(request)):
                raise HTTPException(status_code=401, detail="Admin session client binding changed")
            if policy.bind_user_agent and item.get("user_agent_hash") and not hmac.compare_digest(item["user_agent_hash"], self._ua_binding(request)):
                raise HTTPException(status_code=401, detail="Admin session client binding changed")
            touch_interval = max(5, min(60, policy.idle_timeout_seconds // 4))
            if now - int(item["last_seen_at"]) >= touch_interval:
                cur.execute("UPDATE admin_security_sessions SET last_seen_at=%s WHERE nonce=%s", (now, nonce))
                item["last_seen_at"] = now
            return item

    def mark_mfa(self, nonce: str) -> None:
        now = int(time.time())
        with self._connect() as db, db.cursor() as cur:
            cur.execute("UPDATE admin_security_sessions SET mfa_verified_at=%s,last_seen_at=%s WHERE nonce=%s", (now, now, nonce))
            if cur.rowcount != 1:
                raise KeyError("Unknown admin session")

    def mark_reauth(self, nonce: str, until: int) -> None:
        now = int(time.time())
        with self._connect() as db, db.cursor() as cur:
            cur.execute("UPDATE admin_security_sessions SET reauth_until=%s,last_seen_at=%s WHERE nonce=%s", (int(until), now, nonce))
            if cur.rowcount != 1:
                raise KeyError("Unknown admin session")

    def delete(self, nonce: str) -> None:
        with self._connect() as db, db.cursor() as cur:
            cur.execute("DELETE FROM admin_security_sessions WHERE nonce=%s", (nonce,))

    def ready(self) -> bool:
        try:
            with self._connect() as db, db.cursor() as cur:
                cur.execute("SELECT 1")
                return cur.fetchone() is not None
        except psycopg.Error:
            return False
