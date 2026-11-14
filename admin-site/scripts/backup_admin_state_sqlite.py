from __future__ import annotations

import os
import shutil
import sqlite3
import stat
import sys
import tempfile
from pathlib import Path


def main() -> None:
    source_path = Path(os.getenv("ADMIN_AUDIT_DB", "/var/lib/potapoff-admin/audit.db"))
    try:
        source_stat = source_path.lstat()
    except OSError:
        raise SystemExit("Admin SQLite audit database is unavailable") from None
    if not stat.S_ISREG(source_stat.st_mode):
        raise SystemExit("Admin SQLite audit source must be a regular file")

    os.umask(0o077)
    fd, snapshot_path = tempfile.mkstemp(prefix="admin-audit-", suffix=".sqlite", dir="/tmp")
    os.close(fd)
    os.chmod(snapshot_path, 0o600)
    try:
        source = sqlite3.connect(str(source_path), timeout=10)
        target = sqlite3.connect(snapshot_path, timeout=10)
        try:
            source.execute("PRAGMA busy_timeout=10000")
            target.execute("PRAGMA busy_timeout=10000")
            quick_check = source.execute("PRAGMA quick_check").fetchone()
            if not quick_check or quick_check[0] != "ok":
                raise RuntimeError("source integrity check failed")
            source.backup(target)
            integrity = target.execute("PRAGMA integrity_check").fetchone()
            if not integrity or integrity[0] != "ok":
                raise RuntimeError("snapshot integrity check failed")
            target.commit()
        finally:
            target.close()
            source.close()

        with open(snapshot_path, "rb") as snapshot:
            shutil.copyfileobj(snapshot, sys.stdout.buffer, length=1024 * 1024)
        sys.stdout.buffer.flush()
    except Exception:
        raise SystemExit("Admin SQLite audit snapshot failed validation") from None
    finally:
        try:
            os.unlink(snapshot_path)
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
