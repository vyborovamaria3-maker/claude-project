from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.intelligence_memory import (
    IntelligenceDiscovery,
    IntelligenceEdge,
    IntelligenceEntity,
    IntelligenceSnapshot,
    IntelligenceSnapshotEntity,
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _bounded_float(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if parsed != parsed:  # NaN
        return default
    return max(0.0, min(1.0, parsed))


async def persist_intelligence_memory(
    session: AsyncSession,
    *,
    snapshot: dict,
    ai_result: dict | None,
    provider: str | None = None,
    model: str | None = None,
    prompt_version: str | None = None,
) -> dict:
    snapshot_id = str(snapshot.get("snapshotId") or "").strip()
    mint = str(snapshot.get("mint") or "").strip()
    if not snapshot_id or not mint:
        raise ValueError("snapshotId and mint are required")

    existing = await session.get(IntelligenceSnapshot, snapshot_id)
    if existing is not None:
        return {
            "status": "exists",
            "snapshot_id": snapshot_id,
            "entities": 0,
            "edges": 0,
            "discoveries": 0,
        }

    graph = _dict(snapshot.get("graph"))
    nodes = _list(graph.get("nodes"))
    edges = _list(graph.get("edges"))
    result = _dict(ai_result)
    overall_confidence = _dict(result.get("finalIntelligence")).get("confidence")
    if overall_confidence is None:
        overall_confidence = result.get("overallConfidence")

    row = IntelligenceSnapshot(
        snapshot_id=snapshot_id,
        mint_address=mint[:64],
        symbol=(str(snapshot.get("symbol"))[:32] if snapshot.get("symbol") else None),
        token_name=(str(snapshot.get("tokenName"))[:128] if snapshot.get("tokenName") else None),
        snapshot_version=str(snapshot.get("version") or "unknown")[:80],
        graph_version=str(snapshot.get("graphVersion") or graph.get("version") or "unknown")[:80],
        feature_count=int(snapshot.get("featureCount") or len(_list(snapshot.get("features")))),
        missing_feature_count=int(snapshot.get("missingFeatureCount") or 0),
        provider=(provider[:64] if provider else None),
        model=(model[:160] if model else None),
        prompt_version=(prompt_version[:80] if prompt_version else None),
        overall_confidence=_bounded_float(overall_confidence) if overall_confidence is not None else None,
        payload=snapshot,
        ai_result=ai_result,
        created_at=utcnow(),
    )
    session.add(row)
    await session.flush()

    now = utcnow()
    entity_count = 0
    for raw_node in nodes[:1000]:
        node = _dict(raw_node)
        entity_key = str(node.get("id") or "").strip()[:160]
        entity_type = str(node.get("type") or "unknown").strip()[:32]
        label = str(node.get("label") or entity_key).strip()[:1000]
        if not entity_key:
            continue
        entity = (
            await session.execute(
                select(IntelligenceEntity).where(IntelligenceEntity.entity_key == entity_key)
            )
        ).scalar_one_or_none()
        if entity is None:
            entity = IntelligenceEntity(
                entity_key=entity_key,
                entity_type=entity_type,
                label=label,
                occurrence_count=1,
                first_seen_at=now,
                last_seen_at=now,
                attributes=_dict(node.get("attributes")) or None,
            )
            session.add(entity)
        else:
            entity.occurrence_count += 1
            entity.last_seen_at = now
            entity.label = label or entity.label
            if node.get("attributes"):
                entity.attributes = _dict(node.get("attributes"))

        session.add(
            IntelligenceSnapshotEntity(
                snapshot_id=snapshot_id,
                entity_key=entity_key,
                entity_type=entity_type,
                label=label,
                attributes=_dict(node.get("attributes")) or None,
            )
        )
        entity_count += 1

    edge_count = 0
    for raw_edge in edges[:2500]:
        edge = _dict(raw_edge)
        source = str(edge.get("source") or "").strip()[:160]
        target = str(edge.get("target") or "").strip()[:160]
        edge_type = str(edge.get("type") or "unknown").strip()[:64]
        if not source or not target:
            continue
        confidence = _bounded_float(edge.get("confidence"))
        memory_edge = (
            await session.execute(
                select(IntelligenceEdge).where(
                    and_(
                        IntelligenceEdge.source_key == source,
                        IntelligenceEdge.target_key == target,
                        IntelligenceEdge.edge_type == edge_type,
                    )
                )
            )
        ).scalar_one_or_none()
        if memory_edge is None:
            memory_edge = IntelligenceEdge(
                source_key=source,
                target_key=target,
                edge_type=edge_type,
                occurrence_count=1,
                confidence_sum=confidence,
                max_confidence=confidence,
                first_seen_at=now,
                last_seen_at=now,
                last_snapshot_id=snapshot_id,
                evidence=_list(edge.get("evidenceIds"))[:50] or None,
                attributes=_dict(edge.get("attributes")) or None,
            )
            session.add(memory_edge)
        else:
            memory_edge.occurrence_count += 1
            memory_edge.confidence_sum += confidence
            memory_edge.max_confidence = max(memory_edge.max_confidence, confidence)
            memory_edge.last_seen_at = now
            memory_edge.last_snapshot_id = snapshot_id
            memory_edge.evidence = _list(edge.get("evidenceIds"))[:50] or memory_edge.evidence
            if edge.get("attributes"):
                memory_edge.attributes = _dict(edge.get("attributes"))
        edge_count += 1

    discovery_count = 0
    discoveries: list[dict] = []
    discoveries.extend(_list(result.get("discoveredRelationships")))
    for anomaly in _list(result.get("anomalies")):
        a = _dict(anomaly)
        discoveries.append(
            {
                "source": None,
                "target": None,
                "type": f"anomaly:{str(a.get('type') or 'unknown')}",
                "status": "hypothesis",
                "confidence": a.get("confidence"),
                "rationale": a.get("explanation"),
                "evidenceMessageIds": a.get("evidenceMessageIds"),
                "relatedFeatureKeys": a.get("relatedFeatureKeys"),
                "payload": a,
            }
        )
    for contradiction in _list(result.get("contradictions")):
        c = _dict(contradiction)
        discoveries.append(
            {
                "source": None,
                "target": None,
                "type": "contradiction",
                "status": "contradicted",
                "confidence": c.get("confidence"),
                "rationale": c.get("statement"),
                "evidenceMessageIds": c.get("evidenceMessageIds"),
                "payload": c,
            }
        )

    for raw_discovery in discoveries[:500]:
        discovery = _dict(raw_discovery)
        dtype = str(discovery.get("type") or "other")[:120]
        session.add(
            IntelligenceDiscovery(
                snapshot_id=snapshot_id,
                source_key=(str(discovery.get("source"))[:512] if discovery.get("source") else None),
                target_key=(str(discovery.get("target"))[:512] if discovery.get("target") else None),
                discovery_type=dtype,
                status=str(discovery.get("status") or "hypothesis")[:32],
                confidence=_bounded_float(discovery.get("confidence")),
                rationale=str(discovery.get("rationale") or discovery.get("explanation") or "")[:10000],
                evidence_ids=_list(discovery.get("evidenceMessageIds"))[:50] or None,
                related_feature_keys=_list(discovery.get("relatedFeatureKeys"))[:50] or None,
                payload=_dict(discovery.get("payload")) or discovery,
                created_at=now,
            )
        )
        discovery_count += 1

    await session.commit()
    return {
        "status": "stored",
        "snapshot_id": snapshot_id,
        "entities": entity_count,
        "edges": edge_count,
        "discoveries": discovery_count,
    }


async def token_memory_history(session: AsyncSession, mint: str, *, limit: int = 20) -> list[dict]:
    rows = (
        await session.execute(
            select(IntelligenceSnapshot)
            .where(IntelligenceSnapshot.mint_address == mint)
            .order_by(IntelligenceSnapshot.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return [
        {
            "snapshot_id": row.snapshot_id,
            "mint": row.mint_address,
            "symbol": row.symbol,
            "token_name": row.token_name,
            "snapshot_version": row.snapshot_version,
            "graph_version": row.graph_version,
            "feature_count": row.feature_count,
            "missing_feature_count": row.missing_feature_count,
            "provider": row.provider,
            "model": row.model,
            "prompt_version": row.prompt_version,
            "overall_confidence": row.overall_confidence,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]


async def entity_memory(session: AsyncSession, entity_key: str, *, edge_limit: int = 100) -> dict | None:
    entity = (
        await session.execute(
            select(IntelligenceEntity).where(IntelligenceEntity.entity_key == entity_key)
        )
    ).scalar_one_or_none()
    if entity is None:
        return None

    edges = (
        await session.execute(
            select(IntelligenceEdge)
            .where(or_(IntelligenceEdge.source_key == entity_key, IntelligenceEdge.target_key == entity_key))
            .order_by(IntelligenceEdge.occurrence_count.desc(), IntelligenceEdge.last_seen_at.desc())
            .limit(edge_limit)
        )
    ).scalars().all()
    discoveries = (
        await session.execute(
            select(IntelligenceDiscovery)
            .where(or_(IntelligenceDiscovery.source_key == entity_key, IntelligenceDiscovery.target_key == entity_key))
            .order_by(IntelligenceDiscovery.created_at.desc())
            .limit(edge_limit)
        )
    ).scalars().all()
    return {
        "entity": {
            "key": entity.entity_key,
            "type": entity.entity_type,
            "label": entity.label,
            "occurrence_count": entity.occurrence_count,
            "first_seen_at": entity.first_seen_at.isoformat(),
            "last_seen_at": entity.last_seen_at.isoformat(),
            "attributes": entity.attributes,
        },
        "edges": [
            {
                "source": edge.source_key,
                "target": edge.target_key,
                "type": edge.edge_type,
                "occurrence_count": edge.occurrence_count,
                "avg_confidence": edge.confidence_sum / max(1, edge.occurrence_count),
                "max_confidence": edge.max_confidence,
                "first_seen_at": edge.first_seen_at.isoformat(),
                "last_seen_at": edge.last_seen_at.isoformat(),
                "attributes": edge.attributes,
            }
            for edge in edges
        ],
        "discoveries": [
            {
                "type": row.discovery_type,
                "source": row.source_key,
                "target": row.target_key,
                "status": row.status,
                "confidence": row.confidence,
                "rationale": row.rationale,
                "created_at": row.created_at.isoformat(),
            }
            for row in discoveries
        ],
    }


async def build_memory_context(
    session: AsyncSession,
    *,
    entity_keys: list[str],
    mint: str | None = None,
    max_entities: int = 40,
    max_edges: int = 120,
) -> dict:
    keys = list(dict.fromkeys(key[:160] for key in entity_keys if key))[:max_entities]
    if not keys and not mint:
        return {"entities": [], "edges": [], "discoveries": [], "prior_snapshots": []}

    entities = []
    if keys:
        rows = (
            await session.execute(
                select(IntelligenceEntity).where(IntelligenceEntity.entity_key.in_(keys))
            )
        ).scalars().all()
        entities = [
            {
                "key": row.entity_key,
                "type": row.entity_type,
                "label": row.label,
                "occurrence_count": row.occurrence_count,
                "first_seen_at": row.first_seen_at.isoformat(),
                "last_seen_at": row.last_seen_at.isoformat(),
                "attributes": row.attributes,
            }
            for row in rows
        ]

    edge_rows = []
    if keys:
        edge_rows = (
            await session.execute(
                select(IntelligenceEdge)
                .where(or_(IntelligenceEdge.source_key.in_(keys), IntelligenceEdge.target_key.in_(keys)))
                .order_by(IntelligenceEdge.occurrence_count.desc(), IntelligenceEdge.last_seen_at.desc())
                .limit(max_edges)
            )
        ).scalars().all()
    edges = [
        {
            "source": row.source_key,
            "target": row.target_key,
            "type": row.edge_type,
            "occurrence_count": row.occurrence_count,
            "avg_confidence": row.confidence_sum / max(1, row.occurrence_count),
            "max_confidence": row.max_confidence,
            "last_seen_at": row.last_seen_at.isoformat(),
        }
        for row in edge_rows
    ]

    discovery_rows = []
    if keys:
        discovery_rows = (
            await session.execute(
                select(IntelligenceDiscovery)
                .where(or_(IntelligenceDiscovery.source_key.in_(keys), IntelligenceDiscovery.target_key.in_(keys)))
                .order_by(IntelligenceDiscovery.confidence.desc(), IntelligenceDiscovery.created_at.desc())
                .limit(max_edges)
            )
        ).scalars().all()
    discoveries = [
        {
            "type": row.discovery_type,
            "source": row.source_key,
            "target": row.target_key,
            "status": row.status,
            "confidence": row.confidence,
            "rationale": row.rationale,
            "created_at": row.created_at.isoformat(),
        }
        for row in discovery_rows
    ]

    prior_snapshots = await token_memory_history(session, mint, limit=10) if mint else []
    return {
        "entities": entities,
        "edges": edges,
        "discoveries": discoveries,
        "prior_snapshots": prior_snapshots,
        "stats": {
            "matched_entities": len(entities),
            "historical_edges": len(edges),
            "historical_discoveries": len(discoveries),
            "prior_snapshots": len(prior_snapshots),
        },
    }
