from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
import threading
from collections import defaultdict, deque
from dataclasses import dataclass

from fastapi import HTTPException, Request, status

from .config import Settings


def _b64e(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64d(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def hash_password(password: str, *, n: int = 2**14, r: int = 8, p: int = 1) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=32)
    return f"scrypt${n}${r}${p}${_b64e(salt)}${_b64e(derived)}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, n, r, p, salt, expected = encoded.split("$", 5)
        if algorithm != "scrypt":
            return False
        n_i, r_i, p_i = int(n), int(r), int(p)
        if n_i < 2**14 or n_i > 2**20 or r_i < 1 or r_i > 32 or p_i < 1 or p_i > 16:
            return False
        expected_bytes = _b64d(expected)
        if len(expected_bytes) != 32:
            return False
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=_b64d(salt),
            n=n_i,
            r=r_i,
            p=p_i,
            dklen=len(expected_bytes),
        )
        return hmac.compare_digest(actual, expected_bytes)
    except (ValueError, TypeError):
        return False


def check_admin_password(settings: Settings, username: str, password: str) -> bool:
    if not hmac.compare_digest(username, settings.admin_username):
        return False
    if settings.admin_password_hash:
        return verify_password(password, settings.admin_password_hash)
    return hmac.compare_digest(password, settings.admin_password)


def issue_session(settings: Settings, username: str) -> str:
    now = int(time.time())
    payload = {"sub": username, "iat": now, "exp": now + settings.session_ttl_seconds, "nonce": secrets.token_hex(16)}
    body = _b64e(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = _b64e(hmac.new(settings.session_secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{signature}"


def verify_session(settings: Settings, token: str) -> dict:
    try:
        body, signature = token.split(".", 1)
        expected = _b64e(hmac.new(settings.session_secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            raise ValueError("bad signature")
        payload = json.loads(_b64d(body))
        now = int(time.time())
        issued = int(payload.get("iat", 0))
        expires = int(payload.get("exp", 0))
        nonce = str(payload.get("nonce", ""))
        if payload.get("sub") != settings.admin_username or expires <= now or issued > now + 60 or len(nonce) < 16:
            raise ValueError("expired or invalid")
        if expires - issued > settings.session_ttl_seconds + 60:
            raise ValueError("invalid lifetime")
        return payload
    except (ValueError, TypeError, json.JSONDecodeError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required") from None


def require_admin(request: Request) -> dict:
    settings: Settings = request.app.state.settings
    token = request.cookies.get(settings.session_cookie, "")
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    payload = verify_session(settings, token)
    audit = getattr(request.app.state, "audit", None)
    if audit is not None and audit.is_session_revoked(payload.get("nonce", "")):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    if request.url.path == "/api/logout" and audit is not None:
        audit.revoke_session(payload["nonce"], int(payload["exp"]))
    return payload


@dataclass
class LoginLimiter:
    max_attempts: int = 8
    window_seconds: int = 15 * 60

    def __post_init__(self) -> None:
        self._attempts: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            values = self._attempts[key]
            while values and now - values[0] > self.window_seconds:
                values.popleft()
            if not values:
                self._attempts.pop(key, None)
                return True
            return len(values) < self.max_attempts

    def record_failure(self, key: str) -> None:
        with self._lock:
            self._attempts[key].append(time.monotonic())

    def clear(self, key: str) -> None:
        with self._lock:
            self._attempts.pop(key, None)
