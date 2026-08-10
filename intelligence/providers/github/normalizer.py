"""Normalize GitHub repository snapshots into intelligence documents."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import uuid4

from intelligence.core.hashing import build_document_hash
from intelligence.core.models import IntelligenceDocument
from intelligence.providers.github.models import RepositorySnapshot


def snapshot_to_document(snapshot: RepositorySnapshot) -> IntelligenceDocument:
    metrics = {
        "stars": snapshot.stars,
        "forks": snapshot.forks,
        "watchers": snapshot.watchers,
        "contributors": snapshot.contributors,
        "commits_30d": snapshot.commits_30d,
        "issues_open": snapshot.issues_open,
        "pull_requests_open": snapshot.pull_requests_open,
        "releases": snapshot.releases,
        "archived": snapshot.archived,
        "created_at": snapshot.created_at.isoformat(),
        "updated_at": snapshot.updated_at.isoformat(),
    }
    content = json.dumps(
        {
            "repository": snapshot.full_name,
            "metrics": metrics,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    document = IntelligenceDocument(
        id=str(uuid4()),
        source="github",
        provider="github-rest",
        content=content,
        collected_at=datetime.now(timezone.utc),
        url=snapshot.url,
        author=snapshot.full_name.split("/", 1)[0],
        published_at=snapshot.updated_at,
        entities=["repository", snapshot.full_name],
        metrics=metrics,
    )
    document.raw_hash = build_document_hash(document)
    return document
