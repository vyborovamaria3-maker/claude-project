from __future__ import annotations

import hashlib
import json
import math
import re
from collections import Counter
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models.advanced_intelligence import CampaignFingerprint, IntelligenceOutcome
from app.models.intelligence_memory import (
    IntelligenceSnapshot,
    IntelligenceSnapshotEntity,
)
from app.services.solana_funding_verifier import verify_snapshot_wallet_funding

CAMPAIGN_FINGERPRINT_VERSION = "campaign-fingerprint-v2-canonical"


def _normalize(text: str) -> str:
    value = text.lower()
    value = re.sub(r"https?://\S+", " ", value)
    value = re.sub(r"[1-9A-HJ-NP-Za-km-z]{32,44}", " ", value)
    value = re.sub(r"[^\w\s]+", " ", value, flags=re.UNICODE)
    return " ".join(value.split())[:800]


def _tokens(text: str) -> set[str]:
    return {token for token in _normalize(text).split() if len(token) >= 3}


def _char_ngrams(text: str, size: int = 3) -> Counter[str]:
    normalized = f"  {_normalize(text)}  "
    if len(normalized) < size:
        return Counter()
    return Counter(
        normalized[index : index + size]
        for index in range(len(normalized) - size + 1)
    )


def _cosine(left: Counter[str], right: Counter[str]) -> float:
    if not left or not right:
        return 0.0
    keys = set(left) | set(right)
    dot = sum(left.get(key, 0) * right.get(key, 0) for key in keys)
    norm_left = math.sqrt(sum(value * value for value in left.values()))
    norm_right = math.sqrt(sum(value * value for value in right.values()))
    if not norm_left or not norm_right:
        return 0.0
    return dot / (norm_left * norm_right)


def _semantic_similarity(left: str, right: str) -> float:
    left_tokens = _tokens(left)
    right_tokens = _tokens(right)
    union = left_tokens | right_tokens
    token_score = len(left_tokens & right_tokens) / len(union) if union else 0.0
    char_score = _cosine(_char_ngrams(left), _char_ngrams(right))
    return max(0.0, min(1.0, token_score * 0.55 + char_score * 0.45))


def _finite_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _feature_rows(snapshot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(row.get("key")): row
        for row in snapshot.get("features") or []
        if isinstance(row, dict) and row.get("key")
    }


def _feature_number(
    features: dict[str, dict[str, Any]],
    *keys: str,
) -> float | None:
    for key in keys:
        row = features.get(key)
        if not row or row.get("missing") is True:
            continue
        value = _finite_number(row.get("numericValue"))
        if value is None:
            value = _finite_number(row.get("value"))
        if value is not None:
            return value
    return None


def _stable_hash(payload: Any) -> str:
    raw = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _jaccard(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    union = left | right
    return len(left & right) / len(union) if union else 0.0


def _cosine_dict(left: dict[str, float], right: dict[str, float]) -> float:
    keys = set(left) | set(right)
    if not keys:
        return 0.0
    dot = sum(left.get(key, 0.0) * right.get(key, 0.0) for key in keys)
    norm_left = math.sqrt(sum(left.get(key, 0.0) ** 2 for key in keys))
    norm_right = math.sqrt(sum(right.get(key, 0.0) ** 2 for key in keys))
    if not norm_left or not norm_right:
        return 0.0
    return dot / (norm_left * norm_right)


def _normalized_count(value: int | float, cap: float = 50.0) -> float:
    bounded = max(0.0, float(value))
    return min(1.0, math.log1p(bounded) / math.log1p(cap))


def _score01(value: float | None) -> float:
    if value is None:
        return 0.0
    return max(0.0, min(1.0, value / 100.0))


def semantic_template_clusters(snapshot: dict[str, Any]) -> dict[str, Any]:
    evidence = [
        row
        for row in snapshot.get("evidence") or []
        if isinstance(row, dict)
    ]
    prepared = []
    for row in evidence[:160]:
        text = str(row.get("text") or "")
        normalized = _normalize(text)
        if len(normalized) < 20:
            continue
        prepared.append(
            {
                "id": str(row.get("id") or ""),
                "source": str(row.get("source") or "unknown"),
                "text": text,
                "normalized": normalized,
            }
        )

    assigned: set[int] = set()
    clusters: list[dict[str, Any]] = []
    for index, row in enumerate(prepared):
        if index in assigned:
            continue
        members = [index]
        similarities: list[float] = []
        for other_index in range(index + 1, len(prepared)):
            if other_index in assigned:
                continue
            other = prepared[other_index]
            if row["source"] == other["source"]:
                continue
            similarity = _semantic_similarity(row["text"], other["text"])
            if similarity >= 0.72:
                members.append(other_index)
                similarities.append(similarity)
        sources = {prepared[item]["source"] for item in members}
        if len(members) < 2 or len(sources) < 2:
            continue
        assigned.update(members)
        avg_similarity = (
            sum(similarities) / len(similarities) if similarities else 1.0
        )
        evidence_ids = [
            prepared[item]["id"]
            for item in members
            if prepared[item]["id"]
        ][:30]
        clusters.append(
            {
                "cluster_id": f"semantic-template-{index}",
                "sample": prepared[index]["normalized"][:240],
                "messages": len(members),
                "sources": sorted(sources),
                "evidence_ids": evidence_ids,
                "average_similarity": round(avg_similarity, 4),
                "confidence": round(min(0.98, 0.5 + avg_similarity * 0.45), 4),
            }
        )
    clusters.sort(
        key=lambda row: (row["messages"], row["average_similarity"]),
        reverse=True,
    )
    return {
        "method": "token-jaccard+character-trigram-cosine-v1",
        "semantic_embeddings_enabled": False,
        "clusters": clusters[:50],
        "threshold": 0.72,
        "note": (
            "Deterministic semantic-like similarity; no external embedding "
            "model is required."
        ),
    }


def canonical_campaign_fingerprint(snapshot: dict[str, Any]) -> dict[str, Any]:
    graph = snapshot.get("graph") or {}
    nodes = [row for row in graph.get("nodes") or [] if isinstance(row, dict)]
    edges = [row for row in graph.get("edges") or [] if isinstance(row, dict)]
    features = _feature_rows(snapshot)
    node_types = Counter(str(row.get("type") or "unknown") for row in nodes)
    edge_types = Counter(str(row.get("type") or "unknown") for row in edges)
    vector = {
        "x_accounts": _normalized_count(node_types["x_account"]),
        "tg_channels": _normalized_count(node_types["tg_channel"]),
        "wallets": _normalized_count(node_types["wallet"], 100),
        "bundles": _normalized_count(node_types["bundle"], 20),
        "shared_links": _normalized_count(edge_types["shared_link"], 50),
        "copies": _normalized_count(edge_types["copies"], 50),
        "amplifies": _normalized_count(edge_types["amplifies"], 50),
        "mentions_wallet": _normalized_count(edge_types["mentions_wallet"], 50),
        "social_score": _score01(_feature_number(features, "scores.social")),
        "organic": _score01(_feature_number(features, "scores.organic")),
        "manipulation": _score01(_feature_number(features, "scores.manipulation")),
        "early": _score01(_feature_number(features, "scores.early")),
        "alpha": _score01(_feature_number(features, "scores.alpha")),
    }
    actors = sorted(
        str(row.get("id"))
        for row in nodes
        if row.get("id") and row.get("type") in {"x_account", "tg_channel"}
    )
    links = sorted(
        str(row.get("target"))
        for row in edges
        if row.get("type") == "shared_link" and row.get("target")
    )
    payload = {
        "version": CAMPAIGN_FINGERPRINT_VERSION,
        "vector": vector,
        "actors": actors,
        "links": links,
    }
    return {**payload, "hash": _stable_hash(payload)}


async def canonical_campaign_neighbors(
    session: AsyncSession,
    snapshot: dict[str, Any],
    fingerprint: dict[str, Any],
) -> list[dict[str, Any]]:
    current_mint = str(snapshot.get("mint") or "")
    current_snapshot = str(snapshot.get("snapshotId") or "")
    prior = list(
        (
            await session.execute(
                select(CampaignFingerprint)
                .where(CampaignFingerprint.mint_address != current_mint)
                .order_by(CampaignFingerprint.created_at.desc())
                .limit(1000)
            )
        ).scalars().all()
    )
    current_vector = {
        key: float(value)
        for key, value in (fingerprint.get("vector") or {}).items()
        if _finite_number(value) is not None
    }
    current_actors = set(fingerprint.get("actors") or [])
    best_by_mint: dict[str, dict[str, Any]] = {}
    for row in prior:
        if row.snapshot_id == current_snapshot:
            continue
        previous_vector = {
            key: float(value)
            for key, value in (row.vector or {}).items()
            if _finite_number(value) is not None
        }
        vector_similarity = _cosine_dict(current_vector, previous_vector)
        actor_similarity = _jaccard(current_actors, set(row.actors or []))
        similarity = vector_similarity * 0.78 + actor_similarity * 0.22
        if similarity < 0.50:
            continue
        candidate = {
            "snapshot_id": row.snapshot_id,
            "mint": row.mint_address,
            "similarity": round(similarity, 4),
            "vector_similarity": round(vector_similarity, 4),
            "actor_similarity": round(actor_similarity, 4),
            "created_at": row.created_at.isoformat(),
        }
        previous = best_by_mint.get(row.mint_address)
        if previous is None or candidate["similarity"] > previous["similarity"]:
            best_by_mint[row.mint_address] = candidate
    return sorted(
        best_by_mint.values(),
        key=lambda row: row["similarity"],
        reverse=True,
    )[:10]


def canonical_anomalies(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    features = _feature_rows(snapshot)
    mentions = _feature_number(features, "x_twitter.mentions")
    authors = _feature_number(features, "x_twitter.unique_authors")
    engagement = _feature_number(features, "x_twitter.engagement")
    tg_mentions = _feature_number(features, "telegram.mentions")
    tg_channels = _feature_number(features, "telegram.channels")
    bot_risk = _feature_number(features, "x_twitter.bot_risk")
    rows: list[dict[str, Any]] = []
    if mentions is not None and mentions >= 50 and authors is not None:
        ratio = authors / mentions if mentions > 0 else 0.0
        if ratio < 0.15:
            rows.append(
                {
                    "type": "x_low_author_diffusion",
                    "severity": "high",
                    "ratio": round(ratio, 4),
                }
            )
    if mentions is not None and mentions >= 20 and engagement is not None:
        per_mention = engagement / mentions if mentions > 0 else 0.0
        if per_mention > 5000:
            rows.append(
                {
                    "type": "x_engagement_outlier",
                    "severity": "medium",
                    "engagement_per_mention": round(per_mention, 1),
                }
            )
    if tg_mentions is not None and tg_mentions >= 30 and tg_channels is not None:
        ratio = tg_channels / tg_mentions if tg_mentions > 0 else 0.0
        if ratio < 0.08:
            rows.append(
                {
                    "type": "tg_channel_concentration",
                    "severity": "medium",
                    "ratio": round(ratio, 4),
                }
            )
    if bot_risk is not None and bot_risk >= 70 and mentions and mentions >= 20:
        rows.append(
            {
                "type": "high_bot_risk_with_material_x_activity",
                "severity": "high",
                "bot_risk": bot_risk,
            }
        )
    return rows


def canonical_contradictions(
    snapshot: dict[str, Any],
    existing: dict[str, Any],
) -> dict[str, Any]:
    features = _feature_rows(snapshot)
    x_score = _feature_number(features, "scores.x")
    tg_score = _feature_number(features, "scores.telegram")
    organic = _feature_number(features, "scores.organic")
    manipulation = _feature_number(features, "scores.manipulation")
    bot_risk = _feature_number(features, "x_twitter.bot_risk")
    rows = [
        row
        for row in existing.get("items") or []
        if isinstance(row, dict) and row.get("type") == "ai_reported"
    ]
    if x_score is not None and tg_score is not None and abs(x_score - tg_score) >= 30:
        rows.append(
            {
                "type": "cross_platform_disagreement",
                "severity": "medium",
                "values": {"x": x_score, "tg": tg_score},
            }
        )
    if (
        organic is not None
        and manipulation is not None
        and organic >= 70
        and manipulation >= 70
    ):
        rows.append(
            {
                "type": "organic_manipulation_conflict",
                "severity": "high",
                "values": {"organic": organic, "manipulation": manipulation},
            }
        )
    if bot_risk is not None and x_score is not None and bot_risk >= 65 and x_score >= 75:
        rows.append(
            {
                "type": "high_x_score_high_bot_risk",
                "severity": "high",
                "values": {"x_score": x_score, "bot_risk": bot_risk},
            }
        )
    anomalies = canonical_anomalies(snapshot)
    return {
        "items": rows[:60],
        "count": len(rows),
        "anomaly_discovery": {"items": anomalies, "count": len(anomalies)},
    }


def canonical_evidence_quality(snapshot: dict[str, Any]) -> dict[str, Any]:
    graph = snapshot.get("graph") or {}
    edges = [row for row in graph.get("edges") or [] if isinstance(row, dict)]
    evidence = [row for row in snapshot.get("evidence") or [] if isinstance(row, dict)]
    unique_evidence = {str(row.get("id")) for row in evidence if row.get("id")}
    unique_sources = {str(row.get("source")) for row in evidence if row.get("source")}
    verified_onchain = {
        (str(row.get("source")), str(row.get("target")), str(row.get("type")))
        for row in edges
        if row.get("type") in {"trades", "bundle_member"}
    }
    direct_edges = {
        (str(row.get("source")), str(row.get("target")), str(row.get("type")))
        for row in edges
        if row.get("type") in {"mentions", "calls", "shared_link", "mentions_wallet"}
    }
    derived_edges = {
        (str(row.get("source")), str(row.get("target")), str(row.get("type")))
        for row in edges
        if row.get("type") in {"copies", "amplifies"}
    }
    evidence_coverage = min(1.0, len(unique_evidence) / 40.0)
    source_coverage = min(1.0, len(unique_sources) / 12.0)
    onchain_coverage = min(1.0, len(verified_onchain) / 20.0)
    direct_coverage = min(1.0, len(direct_edges) / 30.0)
    derived_support = min(1.0, len(derived_edges) / 20.0)
    score = 100 * (
        evidence_coverage * 0.28
        + source_coverage * 0.22
        + onchain_coverage * 0.22
        + direct_coverage * 0.20
        + derived_support * 0.08
    )
    return {
        "score": round(score, 1),
        "unique_evidence_items": len(unique_evidence),
        "unique_sources": len(unique_sources),
        "unique_verified_onchain_edges": len(verified_onchain),
        "unique_direct_edges": len(direct_edges),
        "unique_derived_edges": len(derived_edges),
        "note": "Duplicate observations do not independently increase evidence quality.",
    }


def canonical_narrative_strength(
    snapshot: dict[str, Any],
    report: dict[str, Any],
) -> dict[str, Any]:
    narrative = dict(report.get("layers", {}).get("narrative_engine") or {})
    primary = _normalize(str(narrative.get("primary") or ""))
    narrative_tokens = {token for token in primary.split() if len(token) >= 4}
    evidence = [row for row in snapshot.get("evidence") or [] if isinstance(row, dict)]
    matching_messages = 0
    matching_sources: set[str] = set()
    if narrative_tokens:
        for row in evidence:
            message_tokens = _tokens(str(row.get("text") or ""))
            overlap = len(narrative_tokens & message_tokens) / len(narrative_tokens)
            if overlap >= 0.30:
                matching_messages += 1
                if row.get("source"):
                    matching_sources.add(str(row.get("source")))
    message_support = matching_messages / len(evidence) if evidence else 0.0
    source_support = min(1.0, len(matching_sources) / 5.0)
    strength = message_support * 0.65 + source_support * 0.35
    narrative.update(
        {
            "strength": round(strength, 4),
            "supporting_messages": matching_messages,
            "supporting_sources": len(matching_sources),
            "method": "current-evidence-message-and-source-support-v2",
        }
    )
    return narrative


async def performance_aware_source_reliability(
    session: AsyncSession,
    snapshot: dict[str, Any],
    base_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    graph = snapshot.get("graph") or {}
    actor_ids = [
        str(row.get("id"))
        for row in graph.get("nodes") or []
        if isinstance(row, dict)
        and row.get("type") in {"x_account", "tg_channel", "wallet"}
    ][:120]
    if not actor_ids:
        return base_rows

    appearances = list(
        (
            await session.execute(
                select(
                    IntelligenceSnapshotEntity.entity_key,
                    IntelligenceSnapshot.snapshot_id,
                    IntelligenceSnapshot.mint_address,
                    IntelligenceSnapshot.created_at,
                )
                .join(
                    IntelligenceSnapshot,
                    IntelligenceSnapshot.snapshot_id
                    == IntelligenceSnapshotEntity.snapshot_id,
                )
                .where(IntelligenceSnapshotEntity.entity_key.in_(actor_ids))
                .order_by(
                    IntelligenceSnapshotEntity.entity_key.asc(),
                    IntelligenceSnapshot.mint_address.asc(),
                    IntelligenceSnapshot.created_at.asc(),
                )
            )
        ).all()
    )
    earliest_by_entity_mint: dict[tuple[str, str], Any] = {}
    for row in appearances:
        key = (row.entity_key, row.mint_address)
        earliest_by_entity_mint.setdefault(key, row)

    canonical_snapshot_ids = {
        row.snapshot_id for row in earliest_by_entity_mint.values()
    }
    outcomes: list[IntelligenceOutcome] = []
    if canonical_snapshot_ids:
        outcomes = list(
            (
                await session.execute(
                    select(IntelligenceOutcome).where(
                        IntelligenceOutcome.snapshot_id.in_(canonical_snapshot_ids),
                        IntelligenceOutcome.horizon_hours == 72,
                    )
                )
            ).scalars().all()
        )
    outcome_by_snapshot = {row.snapshot_id: row for row in outcomes}

    per_entity: dict[str, dict[str, Any]] = {}
    for (entity_key, mint), row in earliest_by_entity_mint.items():
        bucket = per_entity.setdefault(
            entity_key,
            {
                "mints": set(),
                "matured_mints": set(),
                "wins": 0,
                "collapses": 0,
                "multiples": [],
            },
        )
        bucket["mints"].add(mint)
        outcome = outcome_by_snapshot.get(row.snapshot_id)
        if outcome is None or outcome.max_multiple is None:
            continue
        bucket["matured_mints"].add(mint)
        bucket["wins"] += int(outcome.max_multiple >= 2)
        bucket["collapses"] += int(
            outcome.max_drawdown_pct is not None
            and outcome.max_drawdown_pct <= -80
        )
        bucket["multiples"].append(float(outcome.max_multiple))

    base_by_entity = {str(row.get("entity")): row for row in base_rows}
    enriched = []
    for entity in actor_ids:
        base = dict(base_by_entity.get(entity) or {"entity": entity})
        stats = per_entity.get(entity) or {}
        matured = len(stats.get("matured_mints") or set())
        multiples = sorted(stats.get("multiples") or [])
        median_multiple = None
        if multiples:
            middle = len(multiples) // 2
            median_multiple = (
                multiples[middle]
                if len(multiples) % 2
                else (multiples[middle - 1] + multiples[middle]) / 2
            )
        base.update(
            {
                "distinct_token_occurrences": (
                    len(stats.get("mints") or set())
                    or int(base.get("distinct_token_occurrences") or 0)
                ),
                "matured_72h_samples": matured,
                "historical_2x_rate_72h": (
                    round(stats.get("wins", 0) / matured, 4) if matured else None
                ),
                "historical_collapse_rate_72h": (
                    round(stats.get("collapses", 0) / matured, 4)
                    if matured
                    else None
                ),
                "median_max_multiple_72h": median_multiple,
                "performance_status": (
                    "calibrated_history" if matured >= 10 else "limited_outcome_history"
                ),
                "selection_rule": "earliest_snapshot_per_entity_and_mint",
            }
        )
        enriched.append(base)
    enriched.sort(
        key=lambda row: (
            row.get("matured_72h_samples") or 0,
            row.get("distinct_token_occurrences") or 0,
        ),
        reverse=True,
    )
    return enriched


def recalculate_dynamic_budget(layers: dict[str, Any]) -> dict[str, Any]:
    contradictions = layers.get("contradictions") or {}
    anomaly_count = int((contradictions.get("anomaly_discovery") or {}).get("count") or 0)
    contradiction_count = int(contradictions.get("count") or 0)
    identity_count = len((layers.get("identity_resolution") or {}).get("candidates") or [])
    evidence_score = _finite_number((layers.get("evidence_quality") or {}).get("score")) or 0.0
    evidence_uncertainty = 1.0 - min(1.0, evidence_score / 100.0)
    pressure = min(
        1.0,
        anomaly_count / 8
        + contradiction_count / 6
        + identity_count / 16
        + evidence_uncertainty * 0.25,
    )
    if pressure >= 0.70:
        rounds, entities = 3, 12
    elif pressure >= 0.35:
        rounds, entities = 2, 8
    else:
        rounds, entities = 1, 5
    return {
        "uncertainty_pressure": round(pressure, 4),
        "recommended_research_rounds": rounds,
        "recommended_entity_budget": entities,
        "production_hard_cap_rounds": 3,
        "production_hard_cap_entities": 12,
        "inputs": {
            "anomalies": anomaly_count,
            "contradictions": contradiction_count,
            "identity_candidates": identity_count,
            "evidence_score": evidence_score,
        },
    }


async def enrich_advanced_report(
    session: AsyncSession,
    settings: Settings,
    *,
    snapshot: dict[str, Any],
    report: dict[str, Any],
) -> dict[str, Any]:
    layers = report.get("layers") or {}

    funding = await verify_snapshot_wallet_funding(
        settings,
        snapshot,
        max_wallets=8,
    )
    existing_funding = dict(layers.get("funding_verification") or {})
    existing_funding.update(
        {
            "rpc": funding,
            "verified_by_rpc": bool(funding.get("initial_funding_edges")),
            "verified_edges": funding.get("initial_funding_edges") or [],
            "observed_incoming_transfers": funding.get("observed_incoming_transfers") or [],
            "same_funder_groups": funding.get("same_funder_groups") or [],
            "status": (
                "rpc_verified_initial_funding"
                if funding.get("initial_funding_edges")
                else existing_funding.get("status", "insufficient_data")
            ),
        }
    )
    layers["funding_verification"] = existing_funding

    fingerprint = canonical_campaign_fingerprint(snapshot)
    fingerprint["nearest_neighbors"] = await canonical_campaign_neighbors(
        session,
        snapshot,
        fingerprint,
    )
    layers["campaign_fingerprint"] = fingerprint
    layers["historical_nearest_neighbors"] = fingerprint["nearest_neighbors"]

    layers["text_template_clustering"] = semantic_template_clusters(snapshot)
    layers["source_reliability"] = await performance_aware_source_reliability(
        session,
        snapshot,
        list(layers.get("source_reliability") or []),
    )
    layers["contradictions"] = canonical_contradictions(
        snapshot,
        dict(layers.get("contradictions") or {}),
    )
    layers["evidence_quality"] = canonical_evidence_quality(snapshot)
    report["layers"] = layers
    layers["narrative_engine"] = canonical_narrative_strength(snapshot, report)
    layers["dynamic_research_budget"] = recalculate_dynamic_budget(layers)

    critic_targets = []
    if layers["contradictions"].get("count"):
        critic_targets.append("resolve deterministic contradictions")
    if not existing_funding.get("verified_by_rpc"):
        critic_targets.append("do not infer funding or common control without initial-funding proof")
    if (layers.get("identity_resolution") or {}).get("candidates"):
        critic_targets.append("challenge possible_same_operator hypotheses")
    if fingerprint.get("nearest_neighbors"):
        critic_targets.append("test campaign similarity against coincidence and base rates")
    layers["dedicated_critic"] = {
        "required": bool(critic_targets),
        "independent_pass": True,
        "targets": critic_targets,
        "rule": "Critic receives facts and proposed conclusions, not hidden analyst reasoning.",
    }

    report["layers"] = layers
    report["layer_count"] = len(layers)
    return report
