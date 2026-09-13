from __future__ import annotations

import re
from pathlib import Path


REVISION_PATTERN = re.compile(r'^revision\s*=\s*["\']([^"\']+)["\']', re.MULTILINE)


def test_alembic_revision_ids_fit_default_version_table():
    versions_dir = Path(__file__).resolve().parents[1] / "alembic" / "versions"
    revisions: dict[str, str] = {}

    for path in sorted(versions_dir.glob("*.py")):
        match = REVISION_PATTERN.search(path.read_text(encoding="utf-8"))
        if match is None:
            continue
        revision = match.group(1)
        assert len(revision) <= 32, (
            f"{path.name}: revision {revision!r} is {len(revision)} characters; "
            "Alembic's default version_num column is VARCHAR(32)"
        )
        assert revision not in revisions, (
            f"duplicate Alembic revision {revision!r}: {revisions[revision]} and {path.name}"
        )
        revisions[revision] = path.name

    assert revisions, "no Alembic revisions discovered"
