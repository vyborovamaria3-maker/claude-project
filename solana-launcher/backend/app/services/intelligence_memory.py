from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.intelligence_memory import (
    IntelligenceDiscovery,
    IntelligenceEdge,
    IntelligenceEntity,
    IntelligenceSnapshot,
    IntelligenceSnapshotEdge,
    IntelligenceSnapshotEntity,
)


def utcnow() -> datetime:
    return datetime.now(UTC)


def _dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _bounded_float(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if parsed != parsed:
        return default
    return max(0.0, min(1.0, parsed))


def _canonical_ref(
    value: Any,
    node_ids: set[str],
    label_to_id: dict[str, str],
) -> str | None:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if raw in node_ids:
        return raw
    mapped = label_to_id.get(raw.casefold())
    return mapped or raw[:512]


def _parse_nodes(nodes: list) -> list[tuple[str, str, str, dict | None]]:
    parsed: list[tuple[str, str, str, dict | None]] = []
    seen: set[str] = set()
    for raw_node in nodes[:1000]:
        node = _dict(raw_node)
        key = str(node.get("id") or "").strip()[:160]
        if not key or key in seen:
            continue
        seen.add(key)
        entity_type = str(node.get("type") or "unknown").strip()[:32]
        label = str(node.get("label") or key).strip()[:1000]
        attributes = _dict(node.get("attributes")) or None
        parsed.append((key, entity_type, label, attributes))
    return parsed


def _parse_edges(
    edges: list,
) -> list[tuple[str, str, str, float, list | None, dict | None]]:
    parsed: list[tuple[str, str, str, float, list | None, dict | None]] = []
    seen: set[tuple[str, str, str]] = set()
    for raw_edge in edges[:2500]:
        edge = _dict(raw_edge)
        source = str(edge.get("source") or "").strip()[:160]
        target = str(edge.get("target") or "").strip()[:160]
        edge_type = str(edge.get("type") or "unknown").strip()[:64]
        signature = (source, target, edge_type)
        if not source or not target or signature in seen:
            continue
        seen.add(signature)
        parsed.append(
            (
                source,
                target,
                edge_type,
                _bounded_float(edge.get("confidence")),
                _list(edge.get("evidenceIds"))[:50] or None,
                _dict(edge.get("attributes")) or None,
            )
        )
    return parsed


async def persist_intelligence_memory(
    session: AsyncSession,
    *,
    snapshot: dict,
    ai_result: dict | None,
    analysis_snapshot: dict | None = None,
    provider: str | None = None,
    model: str | None = None,
    prompt_version: str | None = None,
    _retry_on_conflict: bool = True,
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
    parsed_nodes = _parse_nodes(_list(graph.get("nodes")))
    parsed_edges = _parse_edges(_list(graph.get("edges")))
    result = _dict(ai_result)
    actual_input = analysis_snapshot or snapshot
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
        feature_count=int(
            actual_input.get("featureCount") or len(_list(actual_input.get("features")))
        ),
        missing_feature_count=int(actual_input.get("missingFeatureCount") or 0),
        provider=(provider[:64] if provider else None),
        model=(model[:160] if model else None),
        prompt_version=(prompt_version[:80] if prompt_version else None),
        overall_confidence=(
            _bounded_float(overall_confidence) if overall_confidence is not None else None
        ),
        payload=snapshot,
        analysis_payload=analysis_snapshot,
        ai_result=ai_result,
        created_at=utcnow(),
    )
    session.add(row)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        return {
            "status": "exists",
            "snapshot_id": snapshot_id,
            "entities": 0,
            "edges": 0,
            "discoveries": 0,
        }

    now = utcnow()
    node_ids = {item[0] for item in parsed_nodes}
    label_to_id = {item[2].casefold(): item[0] for item in parsed_nodes if item[2]}

    existing_entities: dict[str, IntelligenceEntity] = {}
    seen_entity_keys_on_mint: set[str] = set()
    if node_ids:
        entity_rows = (
            (
                await session.execute(
                    select(IntelligenceEntity).where(IntelligenceEntity.entity_key.in_(node_ids))
                )
            )
            .scalars()
            .all()
        )
        existing_entities = {item.entity_key: item for item in entity_rows}

        seen_rows = await session.execute(
            select(IntelligenceSnapshotEntity.entity_key)
            .join(
                IntelligenceSnapshot,
                IntelligenceSnapshot.snapshot_id == IntelligenceSnapshotEntity.snapshot_id,
            )
            .where(
                IntelligenceSnapshotEntity.entity_key.in_(node_ids),
                IntelligenceSnapshot.mint_address == mint,
                IntelligenceSnapshot.snapshot_id != snapshot_id,
            )
        )
        seen_entity_keys_on_mint = set(seen_rows.scalars().all())

    for key, entity_type, label, attributes in parsed_nodes:
        entity = existing_entities.get(key)
        if entity is None:
            entity = IntelligenceEntity(
                entity_key=key,
                entity_type=entity_type,
                label=label,
                occurrence_count=1,
                first_seen_at=now,
                last_seen_at=now,
                attributes=attributes,
            )
            session.add(entity)
        else:
            if key not in seen_entity_keys_on_mint:
                entity.occurrence_count += 1
            entity.last_seen_at = now
            entity.label = label or entity.label
            if attributes:
                entity.attributes = attributes

        session.add(
            IntelligenceSnapshotEntity(
                snapshot_id=snapshot_id,
                entity_key=key,
                entity_type=entity_type,
                label=label,
                attributes=attributes,
            )
        )

    edge_sources = {item[0] for item in parsed_edges}
    existing_edges: dict[tuple[str, str, str], IntelligenceEdge] = {}
    seen_edges_on_mint: set[tuple[str, str, str]] = set()
    if edge_sources:
        edge_rows = (
            (
                await session.execute(
                    select(IntelligenceEdge).where(IntelligenceEdge.source_key.in_(edge_sources))
                )
            )
            .scalars()
            .all()
        )
        existing_edges = {
            (item.source_key, item.target_key, item.edge_type): item for item in edge_rows
        }

        seen_rows = await session.execute(
            select(
                IntelligenceSnapshotEdge.source_key,
                IntelligenceSnapshotEdge.target_key,
                IntelligenceSnapshotEdge.edge_type,
            )
            .join(
                IntelligenceSnapshot,
                IntelligenceSnapshot.snapshot_id == IntelligenceSnapshotEdge.snapshot_id,
            )
            .where(
                IntelligenceSnapshotEdge.source_key.in_(edge_sources),
                IntelligenceSnapshot.mint_address == mint,
                IntelligenceSnapshot.snapshot_id != snapshot_id,
            )
        )
        seen_edges_on_mint = {
            (source, target, edge_type) for source, target, edge_type in seen_rows.all()
        }

    for source, target, edge_type, confidence, evidence, attributes in parsed_edges:
        signature = (source, target, edge_type)
        memory_edge = existing_edges.get(signature)
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
                evidence=evidence,
                attributes=attributes,
            )
            session.add(memory_edge)
        else:
            if signature not in seen_edges_on_mint:
                memory_edge.occurrence_count += 1
                memory_edge.confidence_sum += confidence
            memory_edge.max_confidence = max(memory_edge.max_confidence, confidence)
            memory_edge.last_seen_at = now
            memory_edge.last_snapshot_id = snapshot_id
            memory_edge.evidence = evidence or memory_edge.evidence
            if attributes:
                memory_edge.attributes = attributes

        session.add(
            IntelligenceSnapshotEdge(
                snapshot_id=snapshot_id,
                source_key=source,
                target_key=target,
                edge_type=edge_type,
                confidence=confidence,
                evidence=evidence,
                attributes=attributes,
            )
        )

    discoveries: list[dict] = []
    discoveries.extend(_list(result.get("discoveredRelationships")))
    for anomaly in _list(result.get("anomalies")):
        item = _dict(anomaly)
        discoveries.append(
            {
                "source": None,
                "target": None,
                "type": f"anomaly:{str(item.get('type') or 'unknown')}",
                "status": "hypothesis",
                "confidence": item.get("confidence"),
                "rationale": item.get("explanation"),
                "evidenceMessageIds": item.get("evidenceMessageIds"),
                "relatedFeatureKeys": item.get("relatedFeatureKeys"),
                "payload": item,
            }
        )
    for contradiction in _list(result.get("contradictions")):
        item = _dict(contradiction)
        discoveries.append(
            {
                "source": None,
                "target": None,
                "type": "contradiction",
                "status": "contradicted",
                "confidence": item.get("confidence"),
                "rationale": item.get("statement"),
                "evidenceMessageIds": item.get("evidenceMessageIds"),
                "payload": item,
            }
        )

    discovery_count = 0
    seen_discoveries: set[tuple[str, str | None, str | None, str]] = set()
    for raw_discovery in discoveries[:500]:
        discovery = _dict(raw_discovery)
        dtype = str(discovery.get("type") or "other")[:120]
        source_key = _canonical_ref(discovery.get("source"), node_ids, label_to_id)
        target_key = _canonical_ref(discovery.get("target"), node_ids, label_to_id)
        status = str(discovery.get("status") or "hypothesis")[:32]
        discovery_signature = (dtype, source_key, target_key, status)
        if discovery_signature in seen_discoveries:
            continue
        seen_discoveries.add(discovery_signature)
        session.add(
            IntelligenceDiscovery(
                snapshot_id=snapshot_id,
                source_key=source_key,
                target_key=target_key,
                discovery_type=dtype,
                status=status,
                confidence=_bounded_float(discovery.get("confidence")),
                rationale=str(discovery.get("rationale") or discovery.get("explanation") or "")[
                    :10000
                ],
                evidence_ids=(_list(discovery.get("evidenceMessageIds"))[:50] or None),
                related_feature_keys=(_list(discovery.get("relatedFeatureKeys"))[:50] or None),
                payload=_dict(discovery.get("payload")) or discovery,
                created_at=now,
            )
        )
        discovery_count += 1

    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        if not _retry_on_conflict:
            raise
        return await persist_intelligence_memory(
            session,
            snapshot=snapshot,
            analysis_snapshot=analysis_snapshot,
            ai_result=ai_result,
            provider=provider,
            model=model,
            prompt_version=prompt_version,
            _retry_on_conflict=False,
        )

    return {
        "status": "stored",
        "snapshot_id": snapshot_id,
        "entities": len(parsed_nodes),
        "edges": len(parsed_edges),
        "discoveries": discovery_count,
    }


async def token_memory_history(
    session: AsyncSession,
    mint: str,
    *,
    limit: int = 20,
) -> list[dict]:
    rows = (
        (
            await session.execute(
                select(IntelligenceSnapshot)
                .where(IntelligenceSnapshot.mint_address == mint)
                .order_by(IntelligenceSnapshot.created_at.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return [
        {
            "snapshot_id": item.snapshot_id,
            "mint": item.mint_address,
            "symbol": item.symbol,
            "token_name": item.token_name,
            "snapshot_version": item.snapshot_version,
            "graph_version": item.graph_version,
            "feature_count": item.feature_count,
            "missing_feature_count": item.missing_feature_count,
            "provider": item.provider,
            "model": item.model,
            "prompt_version": item.prompt_version,
            "overall_confidence": item.overall_confidence,
            "created_at": item.created_at.isoformat(),
        }
        for item in rows
    ]


async def entity_memory(
    session: AsyncSession,
    entity_key: str,
    *,
    edge_limit: int = 100,
) -> dict | None:
    entity = (
        await session.execute(
            select(IntelligenceEntity).where(IntelligenceEntity.entity_key == entity_key)
        )
    ).scalar_one_or_none()
    if entity is None:
        return None

    edges = (
        (
            await session.execute(
                select(IntelligenceEdge)
                .where(
                    or_(
                        IntelligenceEdge.source_key == entity_key,
                        IntelligenceEdge.target_key == entity_key,
                    )
                )
                .order_by(
                    IntelligenceEdge.occurrence_count.desc(),
                    IntelligenceEdge.last_seen_at.desc(),
                )
                .limit(edge_limit)
            )
        )
        .scalars()
        .all()
    )
    discoveries = (
        (
            await session.execute(
                select(IntelligenceDiscovery)
                .where(
                    or_(
                        IntelligenceDiscovery.source_key == entity_key,
                        IntelligenceDiscovery.target_key == entity_key,
                    )
                )
                .order_by(IntelligenceDiscovery.created_at.desc())
                .limit(edge_limit)
            )
        )
        .scalars()
        .all()
    )
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
                "avg_confidence": (edge.confidence_sum / max(1, edge.occurrence_count)),
                "max_confidence": edge.max_confidence,
                "first_seen_at": edge.first_seen_at.isoformat(),
                "last_seen_at": edge.last_seen_at.isoformat(),
                "attributes": edge.attributes,
            }
            for edge in edges
        ],
        "discoveries": [
            {
                "type": item.discovery_type,
                "source": item.source_key,
                "target": item.target_key,
                "status": item.status,
                "confidence": item.confidence,
                "rationale": item.rationale,
                "created_at": item.created_at.isoformat(),
            }
            for item in discoveries
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
        return {
            "entities": [],
            "edges": [],
            "discoveries": [],
            "prior_snapshots": [],
            "stats": {
                "matched_entities": 0,
                "historical_edges": 0,
                "historical_discoveries": 0,
                "prior_snapshots": 0,
            },
        }

    entities = []
    if keys:
        rows = (
            (
                await session.execute(
                    select(IntelligenceEntity).where(IntelligenceEntity.entity_key.in_(keys))
                )
            )
            .scalars()
            .all()
        )
        entities = [
            {
                "key": item.entity_key,
                "type": item.entity_type,
                "label": item.label,
                "occurrence_count": item.occurrence_count,
                "first_seen_at": item.first_seen_at.isoformat(),
                "last_seen_at": item.last_seen_at.isoformat(),
                "attributes": item.attributes,
            }
            for item in rows
        ]

    edge_rows: Sequence[IntelligenceEdge] = []
    if keys:
        edge_rows = (
            (
                await session.execute(
                    select(IntelligenceEdge)
                    .where(
                        or_(
                            IntelligenceEdge.source_key.in_(keys),
                            IntelligenceEdge.target_key.in_(keys),
                        )
                    )
                    .order_by(
                        IntelligenceEdge.occurrence_count.desc(),
                        IntelligenceEdge.last_seen_at.desc(),
                    )
                    .limit(max_edges)
                )
            )
            .scalars()
            .all()
        )
    edges = [
        {
            "source": item.source_key,
            "target": item.target_key,
            "type": item.edge_type,
            "occurrence_count": item.occurrence_count,
            "avg_confidence": (item.confidence_sum / max(1, item.occurrence_count)),
            "max_confidence": item.max_confidence,
            "last_seen_at": item.last_seen_at.isoformat(),
        }
        for item in edge_rows
    ]

    discovery_rows: Sequence[IntelligenceDiscovery] = []
    if keys:
        discovery_rows = (
            (
                await session.execute(
                    select(IntelligenceDiscovery)
                    .where(
                        or_(
                            IntelligenceDiscovery.source_key.in_(keys),
                            IntelligenceDiscovery.target_key.in_(keys),
                        )
                    )
                    .order_by(
                        IntelligenceDiscovery.confidence.desc(),
                        IntelligenceDiscovery.created_at.desc(),
                    )
                    .limit(max_edges * 3)
                )
            )
            .scalars()
            .all()
        )

    discoveries = []
    seen: set[tuple[str, str | None, str | None, str]] = set()
    for item in discovery_rows:
        signature = (
            item.discovery_type,
            item.source_key,
            item.target_key,
            item.status,
        )
        if signature in seen:
            continue
        seen.add(signature)
        discoveries.append(
            {
                "type": item.discovery_type,
                "source": item.source_key,
                "target": item.target_key,
                "status": item.status,
                "confidence": item.confidence,
                "rationale": item.rationale,
                "created_at": item.created_at.isoformat(),
            }
        )
        if len(discoveries) >= max_edges:
            break

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
