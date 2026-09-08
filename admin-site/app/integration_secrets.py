from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken


class IntegrationSecretError(RuntimeError):
    pass


class IntegrationSecretStore:
    """Encrypted provider-secret storage for admin-managed integrations.

    Provider credentials are encrypted at rest. The master key is never persisted
    in SQLite and must be supplied through ADMIN_SECRETS_MASTER_KEY.
    """

    def __init__(self, path: str, master_key: str) -> None:
        self.path = path
        self._master_key = master_key.strip()
        self._lock = threading.RLock()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with contextlib.closing(self._connect()) as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS integration_secrets(
                  id TEXT PRIMARY KEY,
                  provider TEXT NOT NULL,
                  kind TEXT NOT NULL,
                  name TEXT NOT NULL,
                  ciphertext TEXT NOT NULL,
                  enabled INTEGER NOT NULL DEFAULT 1,
                  metadata_json TEXT NOT NULL DEFAULT '{}',
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  updated_by TEXT
                );
                CREATE INDEX IF NOT EXISTS ix_integration_secrets_provider_kind
                  ON integration_secrets(provider, kind, enabled, updated_at DESC);
                """
            )
            db.commit()

    @property
    def configured(self) -> bool:
        return len(self._master_key) >= 32

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    def _fernet(self) -> Fernet:
        if not self.configured:
            raise IntegrationSecretError("ADMIN_SECRETS_MASTER_KEY is not configured")
        raw = hashlib.sha256(self._master_key.encode("utf-8")).digest()
        return Fernet(base64.urlsafe_b64encode(raw))

    def _encrypt(self, value: str) -> str:
        value = value.strip()
        if not value:
            raise IntegrationSecretError("Secret value cannot be empty")
        return self._fernet().encrypt(value.encode("utf-8")).decode("ascii")

    def _decrypt(self, ciphertext: str) -> str:
        try:
            return self._fernet().decrypt(ciphertext.encode("ascii")).decode("utf-8")
        except (InvalidToken, UnicodeDecodeError, ValueError) as exc:
            raise IntegrationSecretError("Unable to decrypt integration secret") from exc

    @staticmethod
    def _mask(value: str) -> str:
        if not value:
            return ""
        suffix = value[-4:] if len(value) >= 4 else value
        return f"••••••••{suffix}"

    @staticmethod
    def _metadata(value: str | None) -> dict[str, Any]:
        try:
            parsed = json.loads(value or "{}")
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}

    def _public_row(self, row: sqlite3.Row) -> dict[str, Any]:
        metadata = self._metadata(row["metadata_json"])
        return {
            "id": row["id"],
            "provider": row["provider"],
            "kind": row["kind"],
            "name": row["name"],
            "enabled": bool(row["enabled"]),
            "masked": metadata.get("masked") or "••••••••",
            "metadata": {key: value for key, value in metadata.items() if key != "masked"},
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "updated_by": row["updated_by"],
        }

    def list(self, provider: str | None = None, kind: str | None = None) -> list[dict[str, Any]]:
        query = "SELECT * FROM integration_secrets"
        clauses: list[str] = []
        params: list[Any] = []
        if provider:
            clauses.append("provider=?")
            params.append(provider)
        if kind:
            clauses.append("kind=?")
            params.append(kind)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY provider, kind, created_at"
        with contextlib.closing(self._connect()) as db:
            return [self._public_row(row) for row in db.execute(query, params).fetchall()]

    def add(
        self,
        provider: str,
        kind: str,
        name: str,
        value: str,
        username: str,
        *,
        enabled: bool = True,
        secret_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        item_id = secret_id or uuid.uuid4().hex
        public_metadata = dict(metadata or {})
        public_metadata["masked"] = self._mask(value.strip())
        with self._lock, contextlib.closing(self._connect()) as db:
            db.execute(
                """INSERT INTO integration_secrets(
                     id, provider, kind, name, ciphertext, enabled, metadata_json,
                     created_at, updated_at, updated_by
                   ) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                (
                    item_id,
                    provider,
                    kind,
                    name,
                    self._encrypt(value),
                    1 if enabled else 0,
                    json.dumps(public_metadata, ensure_ascii=False, separators=(",", ":")),
                    now,
                    now,
                    username,
                ),
            )
            db.commit()
            row = db.execute("SELECT * FROM integration_secrets WHERE id=?", (item_id,)).fetchone()
        if row is None:
            raise IntegrationSecretError("Unable to save integration secret")
        return self._public_row(row)

    def upsert_singleton(
        self,
        provider: str,
        kind: str,
        name: str,
        value: str,
        username: str,
        *,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        item_id = f"{provider}:{kind}"
        now = datetime.now(timezone.utc).isoformat()
        public_metadata = dict(metadata or {})
        public_metadata["masked"] = self._mask(value.strip())
        ciphertext = self._encrypt(value)
        with self._lock, contextlib.closing(self._connect()) as db:
            existing = db.execute("SELECT created_at FROM integration_secrets WHERE id=?", (item_id,)).fetchone()
            created_at = existing["created_at"] if existing else now
            db.execute(
                """INSERT INTO integration_secrets(
                     id, provider, kind, name, ciphertext, enabled, metadata_json,
                     created_at, updated_at, updated_by
                   ) VALUES(?,?,?,?,?,1,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     name=excluded.name,
                     ciphertext=excluded.ciphertext,
                     enabled=1,
                     metadata_json=excluded.metadata_json,
                     updated_at=excluded.updated_at,
                     updated_by=excluded.updated_by""",
                (
                    item_id,
                    provider,
                    kind,
                    name,
                    ciphertext,
                    json.dumps(public_metadata, ensure_ascii=False, separators=(",", ":")),
                    created_at,
                    now,
                    username,
                ),
            )
            db.commit()
            row = db.execute("SELECT * FROM integration_secrets WHERE id=?", (item_id,)).fetchone()
        if row is None:
            raise IntegrationSecretError("Unable to save integration secret")
        return self._public_row(row)

    def set_enabled(self, item_id: str, enabled: bool, username: str) -> dict[str, Any] | None:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, contextlib.closing(self._connect()) as db:
            cur = db.execute(
                "UPDATE integration_secrets SET enabled=?, updated_at=?, updated_by=? WHERE id=?",
                (1 if enabled else 0, now, username, item_id),
            )
            db.commit()
            if cur.rowcount != 1:
                return None
            row = db.execute("SELECT * FROM integration_secrets WHERE id=?", (item_id,)).fetchone()
        return self._public_row(row) if row is not None else None

    def update_metadata(self, item_id: str, patch: dict[str, Any], username: str) -> dict[str, Any] | None:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, contextlib.closing(self._connect()) as db:
            row = db.execute("SELECT * FROM integration_secrets WHERE id=?", (item_id,)).fetchone()
            if row is None:
                return None
            metadata = self._metadata(row["metadata_json"])
            metadata.update(patch)
            db.execute(
                "UPDATE integration_secrets SET metadata_json=?, updated_at=?, updated_by=? WHERE id=?",
                (json.dumps(metadata, ensure_ascii=False, separators=(",", ":")), now, username, item_id),
            )
            db.commit()
            updated = db.execute("SELECT * FROM integration_secrets WHERE id=?", (item_id,)).fetchone()
        return self._public_row(updated) if updated is not None else None

    def delete(self, item_id: str) -> bool:
        with self._lock, contextlib.closing(self._connect()) as db:
            cur = db.execute("DELETE FROM integration_secrets WHERE id=?", (item_id,))
            db.commit()
            return cur.rowcount == 1

    def delete_provider_kinds(self, provider: str, kinds: list[str]) -> int:
        if not kinds:
            return 0
        placeholders = ",".join("?" for _ in kinds)
        with self._lock, contextlib.closing(self._connect()) as db:
            cur = db.execute(
                f"DELETE FROM integration_secrets WHERE provider=? AND kind IN ({placeholders})",
                [provider, *kinds],
            )
            db.commit()
            return int(cur.rowcount)

    def get_plain(self, item_id: str) -> str | None:
        with contextlib.closing(self._connect()) as db:
            row = db.execute(
                "SELECT ciphertext FROM integration_secrets WHERE id=? AND enabled=1",
                (item_id,),
            ).fetchone()
        return self._decrypt(row["ciphertext"]) if row is not None else None

    def active_values(self, provider: str, kind: str) -> list[str]:
        with contextlib.closing(self._connect()) as db:
            rows = db.execute(
                "SELECT ciphertext FROM integration_secrets WHERE provider=? AND kind=? AND enabled=1 ORDER BY created_at",
                (provider, kind),
            ).fetchall()
        return [self._decrypt(row["ciphertext"]) for row in rows]

    def singleton_value(self, provider: str, kind: str) -> str | None:
        return self.get_plain(f"{provider}:{kind}")
