from __future__ import annotations

import base64
import contextlib
import hashlib
import hmac
import os
import sqlite3
import struct
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, Request, status
from pydantic import BaseModel, Field

from .auth import check_admin_password, verify_session


class MfaBody(BaseModel):
    code: str = Field(min_length=6, max_length=8)


class ReauthBody(BaseModel):
    password: str = Field(min_length=1, max_length=1024)
    code: str = Field(default="", max_length=8)


def _as_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _ip_binding(request: Request) -> str:
    value = request.client.host if request.client else "unknown"
    # Exact binding is deliberate for an admin console; trusted proxy handling already
    # normalizes client_ip in the base app before network policy is evaluated.
    return hashlib.sha256(value.encode("utf-8", errors="ignore")).hexdigest()


def _ua_binding(request: Request) -> str:
    value = request.headers.get("user-agent", "")[:512]
    return hashlib.sha256(value.encode("utf-8", errors="ignore")).hexdigest()


def _decode_totp_secret(secret: str) -> bytes:
    compact = "".join(secret.strip().upper().split()).replace("-", "")
    if len(compact) < 16:
        raise ValueError("TOTP secret is too short")
    padding = "=" * (-len(compact) % 8)
    try:
        raw = base64.b32decode(compact + padding, casefold=True)
    except Exception as exc:
        raise ValueError("Invalid TOTP secret") from exc
    if len(raw) < 10:
        raise ValueError("TOTP secret is too short")
    return raw


def totp_code(secret: str, *, at: int | None = None, step: int = 30, digits: int = 6) -> str:
    raw = _decode_totp_secret(secret)
    counter = int((int(time.time()) if at is None else int(at)) // step)
    digest = hmac.new(raw, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{value % (10 ** digits):0{digits}d}"


def verify_totp(secret: str, code: str, *, at: int | None = None, window: int = 1) -> bool:
    candidate = "".join(ch for ch in str(code) if ch.isdigit())
    if len(candidate) != 6:
        return False
    now = int(time.time()) if at is None else int(at)
    try:
        for delta in range(-window, window + 1):
            if hmac.compare_digest(totp_code(secret, at=now + delta * 30), candidate):
                return True
    except ValueError:
        return False
    return False


@dataclass(frozen=True)
class SecurityPolicy:
    require_mfa: bool
    require_reauth: bool
    require_network_allowlist: bool
    idle_timeout_seconds: int
    reauth_ttl_seconds: int
    bind_ip: bool
    bind_user_agent: bool
    totp_secret: str

    @classmethod
    def load(cls, app: FastAPI) -> "SecurityPolicy":
        production = app.state.settings.environment.lower() == "production"
        policy = cls(
            require_mfa=_as_bool("ADMIN_REQUIRE_MFA", False),
            require_reauth=_as_bool("ADMIN_REQUIRE_REAUTH", False),
            require_network_allowlist=_as_bool("ADMIN_REQUIRE_NETWORK_ALLOWLIST", False),
            idle_timeout_seconds=max(300, min(int(os.getenv("ADMIN_IDLE_TIMEOUT_SECONDS", "1800")), 8 * 60 * 60)),
            reauth_ttl_seconds=max(60, min(int(os.getenv("ADMIN_REAUTH_TTL_SECONDS", "300")), 30 * 60)),
            bind_ip=_as_bool("ADMIN_SESSION_BIND_IP", production),
            bind_user_agent=_as_bool("ADMIN_SESSION_BIND_USER_AGENT", True),
            totp_secret=os.getenv("ADMIN_TOTP_SECRET", "").strip(),
        )
        if policy.require_mfa and not policy.totp_secret:
            raise RuntimeError("ADMIN_TOTP_SECRET is required when ADMIN_REQUIRE_MFA=true")
        if policy.totp_secret:
            _decode_totp_secret(policy.totp_secret)
        if production and policy.require_network_allowlist and not app.state.settings.allowed_networks:
            raise RuntimeError("ADMIN_ALLOWED_NETWORKS is required when ADMIN_REQUIRE_NETWORK_ALLOWLIST=true")
        return policy


class AdminSessionStore:
    def __init__(self, path: str) -> None:
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with contextlib.closing(self.connect()) as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS admin_security_sessions(
                  nonce TEXT PRIMARY KEY,
                  username TEXT NOT NULL,
                  issued_at INTEGER NOT NULL,
                  expires_at INTEGER NOT NULL,
                  last_seen_at INTEGER NOT NULL,
                  mfa_verified_at INTEGER,
                  reauth_until INTEGER,
                  ip_hash TEXT,
                  user_agent_hash TEXT
                );
                CREATE INDEX IF NOT EXISTS ix_admin_security_sessions_expires
                  ON admin_security_sessions(expires_at);
                """
            )
            db.commit()

    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    def _cleanup(self, db: sqlite3.Connection, now: int) -> None:
        db.execute("DELETE FROM admin_security_sessions WHERE expires_at<=?", (now,))

    def get_or_create(self, payload: dict[str, Any], request: Request, policy: SecurityPolicy) -> dict[str, Any]:
        now = int(time.time())
        nonce = str(payload["nonce"])
        with contextlib.closing(self.connect()) as db:
            self._cleanup(db, now)
            row = db.execute("SELECT * FROM admin_security_sessions WHERE nonce=?", (nonce,)).fetchone()
            if row is None:
                db.execute(
                    """INSERT INTO admin_security_sessions(
                         nonce,username,issued_at,expires_at,last_seen_at,mfa_verified_at,reauth_until,ip_hash,user_agent_hash
                       ) VALUES(?,?,?,?,?,?,?,?,?)""",
                    (
                        nonce, str(payload["sub"]), int(payload["iat"]), int(payload["exp"]), now,
                        None, None,
                        _ip_binding(request) if policy.bind_ip else None,
                        _ua_binding(request) if policy.bind_user_agent else None,
                    ),
                )
                db.commit()
                row = db.execute("SELECT * FROM admin_security_sessions WHERE nonce=?", (nonce,)).fetchone()
            return dict(row)

    def validate_and_touch(self, payload: dict[str, Any], request: Request, policy: SecurityPolicy) -> dict[str, Any]:
        now = int(time.time())
        nonce = str(payload["nonce"])
        with contextlib.closing(self.connect()) as db:
            self._cleanup(db, now)
            row = db.execute("SELECT * FROM admin_security_sessions WHERE nonce=?", (nonce,)).fetchone()
            if row is None:
                return self.get_or_create(payload, request, policy)
            item = dict(row)
            if now - int(item["last_seen_at"]) > policy.idle_timeout_seconds:
                db.execute("DELETE FROM admin_security_sessions WHERE nonce=?", (nonce,))
                db.commit()
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin session expired due to inactivity")
            if policy.bind_ip and item.get("ip_hash") and not hmac.compare_digest(item["ip_hash"], _ip_binding(request)):
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin session client binding changed")
            if policy.bind_user_agent and item.get("user_agent_hash") and not hmac.compare_digest(item["user_agent_hash"], _ua_binding(request)):
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin session client binding changed")
            db.execute("UPDATE admin_security_sessions SET last_seen_at=? WHERE nonce=?", (now, nonce))
            db.commit()
            item["last_seen_at"] = now
            return item

    def mark_mfa(self, nonce: str) -> None:
        now = int(time.time())
        with contextlib.closing(self.connect()) as db:
            cur = db.execute("UPDATE admin_security_sessions SET mfa_verified_at=?,last_seen_at=? WHERE nonce=?", (now, now, nonce))
            db.commit()
            if cur.rowcount != 1:
                raise KeyError("Unknown admin session")

    def mark_reauth(self, nonce: str, until: int) -> None:
        now = int(time.time())
        with contextlib.closing(self.connect()) as db:
            cur = db.execute("UPDATE admin_security_sessions SET reauth_until=?,last_seen_at=? WHERE nonce=?", (int(until), now, nonce))
            db.commit()
            if cur.rowcount != 1:
                raise KeyError("Unknown admin session")

    def delete(self, nonce: str) -> None:
        with contextlib.closing(self.connect()) as db:
            db.execute("DELETE FROM admin_security_sessions WHERE nonce=?", (nonce,))
            db.commit()


_SAFE_PATHS = {
    "/api/health", "/api/login", "/api/logout", "/api/me",
    "/api/security/mfa/verify", "/api/security/reauth", "/api/security/session",
}


def _dangerous_mutation(request: Request) -> bool:
    if request.method not in {"POST", "PUT", "PATCH", "DELETE"}:
        return False
    path = request.url.path
    if path in {"/api/login", "/api/logout", "/api/security/mfa/verify", "/api/security/reauth"}:
        return False
    if path.endswith("/backtest"):
        return False
    return path.startswith("/api/")


def install_security(app: FastAPI) -> None:
    policy = SecurityPolicy.load(app)
    store = AdminSessionStore(app.state.settings.audit_db_path)
    app.state.security_policy = policy
    app.state.security_sessions = store

    router = APIRouter()

    def signed_payload(request: Request) -> dict[str, Any]:
        token = request.cookies.get(app.state.settings.session_cookie, "")
        if not token:
            raise HTTPException(status_code=401, detail="Authentication required")
        payload = verify_session(app.state.settings, token)
        if app.state.audit.is_session_revoked(str(payload.get("nonce", ""))):
            raise HTTPException(status_code=401, detail="Authentication required")
        return payload

    @router.get("/api/security/session")
    def security_session(request: Request) -> dict[str, Any]:
        payload = signed_payload(request)
        row = store.validate_and_touch(payload, request, policy)
        now = int(time.time())
        return {
            "authenticated": True,
            "mfa_required": policy.require_mfa,
            "mfa_verified": bool(row.get("mfa_verified_at")),
            "reauth_required": policy.require_reauth,
            "reauth_valid": int(row.get("reauth_until") or 0) > now,
            "idle_timeout_seconds": policy.idle_timeout_seconds,
            "expires_at": int(payload["exp"]),
        }

    @router.post("/api/security/mfa/verify")
    def verify_mfa(body: MfaBody, request: Request) -> dict[str, Any]:
        payload = signed_payload(request)
        store.validate_and_touch(payload, request, policy)
        if not policy.require_mfa:
            store.mark_mfa(str(payload["nonce"]))
            return {"ok": True, "mfa_required": False}
        if not verify_totp(policy.totp_secret, body.code):
            app.state.audit.record(action="mfa", success=False, username=payload["sub"], ip_address=request.client.host if request.client else "unknown")
            raise HTTPException(status_code=401, detail="Invalid MFA code")
        store.mark_mfa(str(payload["nonce"]))
        app.state.audit.record(action="mfa", success=True, username=payload["sub"], ip_address=request.client.host if request.client else "unknown")
        return {"ok": True, "mfa_required": True}

    @router.post("/api/security/reauth")
    def reauth(body: ReauthBody, request: Request) -> dict[str, Any]:
        payload = signed_payload(request)
        row = store.validate_and_touch(payload, request, policy)
        if policy.require_mfa and not row.get("mfa_verified_at"):
            raise HTTPException(status_code=428, detail="MFA verification required first")
        if not check_admin_password(app.state.settings, payload["sub"], body.password):
            app.state.audit.record(action="reauth", success=False, username=payload["sub"], ip_address=request.client.host if request.client else "unknown")
            raise HTTPException(status_code=401, detail="Invalid credentials")
        if policy.require_mfa and not verify_totp(policy.totp_secret, body.code):
            app.state.audit.record(action="reauth", success=False, username=payload["sub"], ip_address=request.client.host if request.client else "unknown", details={"reason":"mfa"})
            raise HTTPException(status_code=401, detail="Invalid MFA code")
        until = int(time.time()) + policy.reauth_ttl_seconds
        store.mark_reauth(str(payload["nonce"]), until)
        app.state.audit.record(action="reauth", success=True, username=payload["sub"], ip_address=request.client.host if request.client else "unknown", details={"valid_until":until})
        return {"ok": True, "valid_until": until}

    app.include_router(router)

    @app.middleware("http")
    async def admin_security_session_middleware(request: Request, call_next):
        path = request.url.path
        if not path.startswith("/api/") or path in {"/api/health", "/api/login"}:
            return await call_next(request)
        token = request.cookies.get(app.state.settings.session_cookie, "")
        if not token:
            return await call_next(request)
        try:
            payload = verify_session(app.state.settings, token)
            if app.state.audit.is_session_revoked(str(payload.get("nonce", ""))):
                raise HTTPException(status_code=401, detail="Authentication required")
            row = store.validate_and_touch(payload, request, policy)
            if path == "/api/logout":
                response = await call_next(request)
                store.delete(str(payload["nonce"]))
                return response
            if policy.require_mfa and path not in {"/api/security/mfa/verify", "/api/security/session"} and not row.get("mfa_verified_at"):
                from fastapi.responses import JSONResponse
                return JSONResponse(status_code=428, content={"detail":"MFA verification required","code":"mfa_required"})
            if policy.require_reauth and _dangerous_mutation(request) and int(row.get("reauth_until") or 0) <= int(time.time()):
                from fastapi.responses import JSONResponse
                return JSONResponse(status_code=428, content={"detail":"Recent re-authentication required","code":"reauth_required"})
            return await call_next(request)
        except HTTPException as exc:
            from fastapi.responses import JSONResponse
            return JSONResponse(status_code=exc.status_code, content={"detail":str(exc.detail)})
