from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.advanced_intelligence import (
    CampaignFingerprint,
    CampaignFingerprintActor,
    CampaignFingerprintFeature,
    IntelligenceHypothesisState,
    IntelligenceNarrativeMemory,
)
from app.services.campaign_similarity import prepare_campaign_projection
from app.services.intelligence_persistence_lock import (
    acquire_intelligence_persistence_locks,
)


def _sha(value: Any) -> str:
    raw = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _confidence(value: Any) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0.0
    if parsed != parsed:
        return 0.0
    return max(0.0, min(1.0, parsed))


def _observation_status(value: str) -> str:
    return value if value in {
        "hypothesis",
        "supported",
        "strengthened",
        "contradicted",
        "rejected",
    } else "hypothesis"


def _aggregate_observations(
    observations: dict[str, dict[str, Any]],
) -> tuple[int, int, float, str]:
    support = 0
    contradictions = 0
    confidences: list[float] = []
    for observation in observations.values():
        status = _observation_status(str(observation.get("status") or "hypothesis"))
        confidences.append(_confidence(observation.get("confidence")))
        if status in {"hypothesis", "supported", "strengthened"}:
            support += 1
        if status in {"contradicted", "rejected"}:
            contradictions += 1
    mean_confidence = sum(confidences) / len(confidences) if confidences else 0.0
    if contradictions > support:
        aggregate_status = "contradicted"
    elif support >= 3 and mean_confidence >= 0.7:
        aggregate_status = "strengthened"
    elif support > 0:
        aggregate_status = "supported"
    else:
        aggregate_status = "hypothesis"
    return support, contradictions, mean_confidence, aggregate_status


def _prepare_discoveries(ai_result: dict[str, Any] | None) -> list[dict[str, Any]]:
    prepared: list[dict[str, Any]] = []
    for discovery in (ai_result or {}).get("discoveredRelationships") or []:
        if not isinstance(discovery, dict):
            continue
        source = str(discovery.get("source") or "") or None
        target = str(discovery.get("target") or "") or None
        discovery_type = str(discovery.get("type") or "other")
        key = _sha(
            {
                "type": discovery_type,
                "source": source,
                "target": target,
            }
        )[:64]
        prepared.append(
            {
                "key": key,
                "source": source,
                "target": target,
                "discovery_type": discovery_type,
                "discovery": discovery,
            }
        )
    return prepared


async def persist_advanced_intelligence_state(
    session: AsyncSession,
    *,
    snapshot: dict[str, Any],
    report: dict[str, Any],
    ai_result: dict[str, Any] | None = None,
    role: str = "analyst",
) -> None:
    snapshot_id = str(snapshot.get("snapshotId") or "")
    mint = str(snapshot.get("mint") or "")
    fingerprint = report["layers"]["campaign_fingerprint"]
    narrative = report["layers"]["narrative_engine"]
    prepared = _prepare_discoveries(ai_result)
    hypothesis_keys = list(dict.fromkeys(str(row["key"]) for row in prepared))

    # Redis single-flight only deduplicates byte-identical analysis requests. A
    # synchronous report or a different AI result can still target the same DB
    # snapshot/narrative/hypothesis rows. Acquire all shared logical keys in one
    # deterministic order before the first read/check/write sequence.
    lock_resources = [f"campaign:{snapshot_id}"]
    if narrative.get("primary_key") and narrative.get("primary"):
        lock_resources.append(f"narrative:{narrative['primary_key']}")
    lock_resources.extend(f"hypothesis:{key}" for key in hypothesis_keys)
    await acquire_intelligence_persistence_locks(session, lock_resources)

    existing = (
        await session.execute(
            select(CampaignFingerprint).where(
                CampaignFingerprint.snapshot_id == snapshot_id
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        created_at = datetime.now(timezone.utc)
        vector = dict(fingerprint.get("vector") or {})
        actors = list(fingerprint.get("actors") or [])
        session.add(
            CampaignFingerprint(
                snapshot_id=snapshot_id,
                mint_address=mint,
                fingerprint_hash=fingerprint["hash"],
                vector=vector,
                actors=actors,
                narratives=[narrative],
                created_at=created_at,
            )
        )
        projection, actor_keys = prepare_campaign_projection(vector, actors)
        if projection is not None:
            session.add(
                CampaignFingerprintFeature(
                    snapshot_id=snapshot_id,
                    mint_address=mint,
                    created_at=created_at,
                    **projection,
                )
            )
            session.add_all(
                CampaignFingerprintActor(
                    snapshot_id=snapshot_id,
                    actor_key=actor_key,
                )
                for actor_key in actor_keys
            )

    if narrative.get("primary_key") and narrative.get("primary"):
        memory = (
            await session.execute(
                select(IntelligenceNarrativeMemory).where(
                    IntelligenceNarrativeMemory.narrative_key
                    == narrative["primary_key"]
                )
            )
        ).scalar_one_or_none()
        actor_keys = fingerprint.get("actors") or []
        if memory is None:
            session.add(
                IntelligenceNarrativeMemory(
                    narrative_key=narrative["primary_key"],
                    label=str(narrative["primary"])[:500],
                    occurrence_count=1,
                    token_mints=[mint],
                    actor_keys=actor_keys[:100],
                    examples=[narrative.get("primary")],
                )
            )
        else:
            mints = list(dict.fromkeys([*(memory.token_mints or []), mint]))[:500]
            actors = list(
                dict.fromkeys([*(memory.actor_keys or []), *actor_keys])
            )[:500]
            memory.occurrence_count = len(mints)
            memory.token_mints = mints
            memory.actor_keys = actors
            memory.last_seen_at = datetime.now(timezone.utc)

    # Load all deterministic hypothesis keys in one round-trip after their locks
    # are held, so concurrent reports cannot race the following JSON merge.
    existing_hypotheses: dict[str, IntelligenceHypothesisState] = {}
    if hypothesis_keys:
        existing_rows = list(
            (
                await session.execute(
                    select(IntelligenceHypothesisState).where(
                        IntelligenceHypothesisState.hypothesis_key.in_(hypothesis_keys)
                    )
                )
            ).scalars().all()
        )
        existing_hypotheses = {row.hypothesis_key: row for row in existing_rows}

    for prepared_row in prepared:
        key = str(prepared_row["key"])
        source = prepared_row["source"]
        target = prepared_row["target"]
        discovery_type = str(prepared_row["discovery_type"])
        discovery = prepared_row["discovery"]
        row = existing_hypotheses.get(key)
        status = _observation_status(
            str(discovery.get("status") or "hypothesis")
        )
        confidence = _confidence(discovery.get("confidence"))
        evidence = [
            *(discovery.get("evidenceMessageIds") or []),
            *(discovery.get("supportingFeatureKeys") or []),
        ]
        observation = {
            "snapshot_id": snapshot_id,
            "role": role,
            "status": status,
            "confidence": confidence,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if row is None:
            observations = {mint: observation}
            support, contradictions, mean, aggregate = _aggregate_observations(
                observations
            )
            row = IntelligenceHypothesisState(
                hypothesis_key=key,
                mint_address=mint,
                hypothesis_type=discovery_type,
                source_key=source,
                target_key=target,
                status=aggregate,
                confidence=mean,
                support_count=support,
                contradiction_count=contradictions,
                evidence=evidence[:100],
                observations=observations,
                payload=discovery,
            )
            session.add(row)
            existing_hypotheses[key] = row
            continue

        observations = dict(row.observations or {})
        existing_observation = observations.get(mint)
        # A critic can override an analyst on the same mint; repeated refreshes do
        # not increase cross-launch support because each mint owns one vote.
        if (
            existing_observation is None
            or role == "critic"
            or existing_observation.get("role") != "critic"
        ):
            observations[mint] = observation
        support, contradictions, mean, aggregate = _aggregate_observations(
            observations
        )
        row.observations = observations
        row.support_count = support
        row.contradiction_count = contradictions
        row.confidence = mean
        row.status = aggregate
        row.evidence = list(
            dict.fromkeys([*(row.evidence or []), *evidence])
        )[-200:]
        row.payload = discovery
        row.updated_at = datetime.now(timezone.utc)

    await session.commit()
