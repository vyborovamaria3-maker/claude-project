from __future__ import annotations

import hashlib
import json
import math
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from statistics import median
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.advanced_intelligence import (
    IntelligenceCalibrationStat,
    IntelligenceHypothesisState,
)
from app.models.intelligence_memory import IntelligenceEntity
from app.services.campaign_similarity import find_campaign_neighbors

ADVANCED_INTELLIGENCE_VERSION = "advanced-intelligence-v2"
CAMPAIGN_FINGERPRINT_VERSION = "campaign-fingerprint-v2"
CAMPAIGN_VECTOR_SCHEMA_KEY = "schema_v2"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _sha(value: Any) -> str:
    raw = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _feature_map(snapshot: dict[str, Any]) -> dict[str, dict[str, Any]]:
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
        value = _number(row.get("numericValue"))
        if value is None:
            value = _number(row.get("value"))
        if value is not None:
            return value
    return None


def _graph(
    snapshot: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    graph = snapshot.get("graph") or {}
    nodes = [row for row in graph.get("nodes") or [] if isinstance(row, dict)]
    edges = [row for row in graph.get("edges") or [] if isinstance(row, dict)]
    return nodes, edges


def _normalize_text(text: str) -> str:
    value = text.lower()
    value = re.sub(r"https?://\S+", " ", value)
    value = re.sub(r"[1-9A-HJ-NP-Za-km-z]{32,44}", " ", value)
    value = re.sub(r"[^\w\s]+", " ", value, flags=re.UNICODE)
    return " ".join(value.split())[:500]


def _actor_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        row
        for row in nodes
        if row.get("type") in {"x_account", "tg_channel"}
    ]


def _wallet_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row for row in nodes if row.get("type") == "wallet"]


def _edge_weight(edge: dict[str, Any]) -> tuple[str, float]:
    edge_type = str(edge.get("type") or "")
    confidence = _clamp(_number(edge.get("confidence")) or 0.0)
    attrs = edge.get("attributes") or {}
    if edge_type == "trades":
        return "verified_onchain", 1.0 * confidence
    if edge_type == "bundle_member":
        # Current bundle detector is a synchronous-buy heuristic, not an atomic bundle proof.
        return "derived", 0.58 * confidence
    if edge_type in {"mentions", "calls", "shared_link"}:
        return "direct_source", 0.88 * confidence
    if edge_type == "mentions_wallet":
        return "direct_source", 0.82 * confidence
    if edge_type == "copies":
        return "derived", 0.78 * confidence
    if edge_type == "amplifies":
        return "derived", 0.68 * confidence
    if attrs.get("verified_by_rpc"):
        return "verified_onchain", 1.0 * confidence
    return "derived", 0.5 * confidence


def _evidence_quality(snapshot: dict[str, Any]) -> dict[str, Any]:
    nodes, edges = _graph(snapshot)
    evidence = [
        row
        for row in snapshot.get("evidence") or []
        if isinstance(row, dict)
    ]
    unique_evidence = {
        str(row.get("id"))
        for row in evidence
        if row.get("id")
    }
    unique_sources = {
        (str(row.get("platform") or ""), str(row.get("source") or ""))
        for row in evidence
        if row.get("source")
    }
    seen_relations: set[tuple[str, str, str]] = set()
    counts: Counter[str] = Counter()
    weights: list[float] = []
    for edge in edges:
        relation = (
            str(edge.get("source") or ""),
            str(edge.get("type") or ""),
            str(edge.get("target") or ""),
        )
        if relation in seen_relations:
            continue
        seen_relations.add(relation)
        grade, weight = _edge_weight(edge)
        counts[grade] += 1
        weights.append(weight)

    memory_features = {
        str(row.get("key"))
        for row in snapshot.get("features") or []
        if str(row.get("key") or "").startswith("memory.")
    }
    research_features = {
        str(row.get("key"))
        for row in snapshot.get("features") or []
        if str(row.get("key") or "").startswith("research.")
    }
    if memory_features:
        counts["historical_prior"] += len(memory_features)
        weights.extend([0.5] * len(memory_features))
    if research_features:
        counts["research_derived"] += len(research_features)
        weights.extend([0.72] * len(research_features))

    quality = sum(weights) / len(weights) if weights else 0.0
    evidence_coverage = min(1.0, len(unique_evidence) / 30.0)
    source_coverage = min(1.0, len(unique_sources) / 12.0)
    relation_coverage = min(1.0, len(seen_relations) / 40.0)
    coverage = (
        evidence_coverage * 0.4
        + source_coverage * 0.3
        + relation_coverage * 0.3
    )
    return {
        "score": round(100 * (quality * 0.7 + coverage * 0.3), 1),
        "quality": round(quality, 4),
        "coverage": round(coverage, 4),
        "classes": dict(counts),
        "unique_evidence_items": len(unique_evidence),
        "unique_sources": len(unique_sources),
        "unique_graph_relations": len(seen_relations),
        "nodes": len(nodes),
        "note": "Bundle/co-buy heuristics are not graded as verified on-chain identity evidence.",
    }


def _funding_verification(snapshot: dict[str, Any]) -> dict[str, Any]:
    explicit: list[dict[str, Any]] = []
    similarity_only: list[dict[str, Any]] = []
    for row in snapshot.get("features") or []:
        key = str(row.get("key") or "")
        if not key.startswith("research.funding_graph."):
            continue
        raw = row.get("value")
        if isinstance(raw, dict):
            payload = raw
        else:
            try:
                payload = json.loads(str(raw or ""))
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
        if not isinstance(payload, dict):
            continue
        explicit.extend(payload.get("explicit_funding_evidence") or [])
        similarity_only.extend(
            payload.get("similarity_links_not_funding_proof") or []
        )
    return {
        "status": "evidence_available" if explicit else "insufficient_data",
        "explicit_edges": explicit[:30],
        "similarity_only": similarity_only[:30],
        "verified_by_rpc": False,
        "note": (
            "Stored evidence remains unverified until RPC enrichment. Similarity, "
            "co-buy timing and shared-token history are never funding proof."
        ),
    }


def _wallet_clusters(snapshot: dict[str, Any]) -> dict[str, Any]:
    nodes, edges = _graph(snapshot)
    wallet_ids = {str(row.get("id")) for row in _wallet_nodes(nodes)}
    bundle_members: dict[str, list[tuple[str, float, bool]]] = defaultdict(list)
    for edge in edges:
        source = str(edge.get("source") or "")
        target = str(edge.get("target") or "")
        if edge.get("type") != "bundle_member" or source not in wallet_ids:
            continue
        attrs = edge.get("attributes") or {}
        bundle_members[target].append(
            (
                source,
                _clamp(_number(edge.get("confidence")) or 0.0),
                bool(attrs.get("verifiedAtomicBundle")),
            )
        )

    clusters = []
    clustered: set[str] = set()
    for bundle_id, rows in bundle_members.items():
        members = sorted({row[0] for row in rows})
        if len(members) < 2:
            continue
        verified = bool(rows) and all(row[2] for row in rows)
        edge_confidence = min((row[1] for row in rows), default=0.0)
        confidence = min(0.98, edge_confidence) if verified else min(0.7, 0.45 + edge_confidence * 0.25)
        clusters.append(
            {
                "cluster_id": f"wallet_cluster:{_sha([bundle_id, members])[:16]}",
                "members": members,
                "confidence": round(confidence, 3),
                "reasons": [
                    "verified_atomic_bundle" if verified else "synchronous_buy_cluster"
                ],
                "status": "verified_cluster" if verified else "heuristic_candidate_cluster",
                "ownership_claim": False,
            }
        )
        clustered.update(members)
    return {
        "clusters": sorted(clusters, key=lambda row: row["confidence"], reverse=True),
        "unclustered_wallets": max(0, len(wallet_ids) - len(clustered)),
        "method": "bundle edge semantics are preserved; heuristic co-buy clusters do not imply common ownership",
    }


def _identity_resolution(snapshot: dict[str, Any]) -> dict[str, Any]:
    nodes, edges = _graph(snapshot)
    actors = {str(row.get("id")): row for row in _actor_nodes(nodes)}
    target_to_actors: dict[str, set[str]] = defaultdict(set)
    target_types: dict[str, str] = {}
    for edge in edges:
        source = str(edge.get("source") or "")
        target = str(edge.get("target") or "")
        if source not in actors or edge.get("type") not in {"shared_link", "mentions_wallet"}:
            continue
        target_to_actors[target].add(source)
        target_types[target] = str(edge.get("type"))

    shared: dict[tuple[str, str], list[str]] = defaultdict(list)
    for target, actor_ids in target_to_actors.items():
        ordered = sorted(actor_ids)
        for index, left in enumerate(ordered):
            for right in ordered[index + 1 :]:
                shared[(left, right)].append(target)

    candidates = []
    for (left, right), targets in shared.items():
        wallet_mentions = sum(
            target_types.get(target) == "mentions_wallet" for target in targets
        )
        shared_links = len(targets) - wallet_mentions
        confidence = min(
            0.72,
            0.22 + wallet_mentions * 0.16 + shared_links * 0.10,
        )
        candidates.append(
            {
                "source": left,
                "target": right,
                "relationship": "possible_same_operator",
                "confidence": round(confidence, 3),
                "shared_targets": sorted(set(targets))[:20],
                "status": "hypothesis",
                "note": "Shared URLs/wallet mentions are coordination clues, not identity proof.",
            }
        )
    candidates.sort(key=lambda row: row["confidence"], reverse=True)
    return {"candidates": candidates[:50]}


def _temporal_graph(snapshot: dict[str, Any]) -> dict[str, Any]:
    _, edges = _graph(snapshot)
    rows = []
    for edge in edges:
        attrs = edge.get("attributes") or {}
        lag = _number(attrs.get("lagSeconds"))
        if lag is None:
            continue
        rows.append(
            {
                "source": edge.get("source"),
                "target": edge.get("target"),
                "type": edge.get("type"),
                "lag_seconds": lag,
                "confidence": edge.get("confidence"),
                "evidence_basis": attrs.get("evidenceBasis"),
            }
        )
    rows.sort(key=lambda row: abs(row["lag_seconds"]))
    lags = [abs(float(row["lag_seconds"])) for row in rows]
    return {
        "sequenced_edges": rows[:100],
        "median_abs_lag_seconds": round(float(median(lags)), 3) if lags else None,
    }


def _scaled_count(value: int, saturation: float) -> float:
    if value <= 0:
        return 0.0
    return _clamp(math.log1p(value) / math.log1p(saturation))


def _score_feature(features: dict[str, dict[str, Any]], *keys: str) -> float:
    value = _feature_number(features, *keys)
    return _clamp((value or 0.0) / 100.0)


def _campaign_vector(snapshot: dict[str, Any]) -> dict[str, float]:
    nodes, edges = _graph(snapshot)
    features = _feature_map(snapshot)
    types = Counter(str(row.get("type") or "unknown") for row in nodes)
    edge_types = Counter(str(row.get("type") or "unknown") for row in edges)
    return {
        CAMPAIGN_VECTOR_SCHEMA_KEY: 1.0,
        "x_accounts": _scaled_count(types["x_account"], 30),
        "tg_channels": _scaled_count(types["tg_channel"], 30),
        "wallets": _scaled_count(types["wallet"], 120),
        "bundles": _scaled_count(types["bundle"], 15),
        "shared_links": _scaled_count(edge_types["shared_link"], 30),
        "copies": _scaled_count(edge_types["copies"], 30),
        "amplifies": _scaled_count(edge_types["amplifies"], 30),
        "mentions_wallet": _scaled_count(edge_types["mentions_wallet"], 30),
        "social_score": _score_feature(features, "scores.social", "combined.social_score", "social.score"),
        "x_score": _score_feature(features, "scores.x", "x.score"),
        "telegram_score": _score_feature(features, "scores.telegram", "tg.score"),
        "organic": _score_feature(features, "scores.organic", "combined.organic", "social.organic"),
        "manipulation": _score_feature(features, "scores.manipulation", "combined.manipulation", "social.manipulation"),
        "early": _score_feature(features, "scores.early", "combined.early", "social.early"),
        "alpha": _score_feature(features, "scores.alpha", "combined.alpha", "social.alpha"),
        "bot_risk": _score_feature(features, "x_twitter.bot_risk", "x.botRisk", "x.bot_risk"),
    }


def _campaign_fingerprint(
    snapshot: dict[str, Any],
    ai_result: dict[str, Any] | None,
) -> dict[str, Any]:
    nodes, edges = _graph(snapshot)
    campaign = (ai_result or {}).get("campaignHypothesis") or {}
    narrative = str(campaign.get("narrative") or "").strip()
    payload = {
        "version": CAMPAIGN_FINGERPRINT_VERSION,
        "vector": _campaign_vector(snapshot),
        "actors": sorted(
            str(row.get("id"))
            for row in _actor_nodes(nodes)
            if row.get("id")
        ),
        "links": sorted(
            str(edge.get("target"))
            for edge in edges
            if edge.get("type") == "shared_link"
        ),
        "narrative": _normalize_text(narrative),
    }
    return {**payload, "hash": _sha(payload)}


def _text_template_clusters(snapshot: dict[str, Any]) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in snapshot.get("evidence") or []:
        if not isinstance(row, dict):
            continue
        normalized = _normalize_text(str(row.get("text") or ""))
        if len(normalized) >= 20:
            groups[normalized].append(row)
    clusters = []
    for template, rows in groups.items():
        sources = sorted({str(row.get("source") or "unknown") for row in rows})
        if len(rows) < 2 or len(sources) < 2:
            continue
        clusters.append(
            {
                "template_hash": _sha(template)[:20],
                "sample": template[:220],
                "messages": len(rows),
                "sources": sources,
                "confidence": min(0.96, 0.68 + 0.04 * len(rows)),
            }
        )
    clusters.sort(key=lambda row: (row["messages"], len(row["sources"])), reverse=True)
    return {
        "clusters": clusters[:50],
        "method": "exact-normalized-text-v2; semantic enrichment may replace this layer",
        "semantic_embeddings_enabled": False,
    }


def _narrative(
    snapshot: dict[str, Any],
    ai_result: dict[str, Any] | None,
) -> dict[str, Any]:
    campaign = (ai_result or {}).get("campaignHypothesis") or {}
    label = str(campaign.get("narrative") or "").strip()
    confidence = _clamp(_number(campaign.get("confidence")) or 0.0)
    tokens = {
        token
        for token in _normalize_text(label).split()
        if len(token) > 3
    }
    supporting_messages = 0
    supporting_sources: set[str] = set()
    term_counts: Counter[str] = Counter()
    for row in snapshot.get("evidence") or []:
        if not isinstance(row, dict):
            continue
        normalized = _normalize_text(str(row.get("text") or ""))
        row_tokens = {token for token in normalized.split() if len(token) > 3}
        term_counts.update(row_tokens)
        if tokens and len(tokens & row_tokens) / max(1, len(tokens)) >= 0.25:
            supporting_messages += 1
            supporting_sources.add(str(row.get("source") or "unknown"))
    evidence_count = len(snapshot.get("evidence") or [])
    support_ratio = supporting_messages / evidence_count if evidence_count else 0.0
    source_support = min(1.0, len(supporting_sources) / 4.0)
    emergent = [word for word, count in term_counts.most_common(12) if count >= 2]
    strength = (
        confidence * 0.45 + support_ratio * 0.35 + source_support * 0.20
        if label
        else min(1.0, len(emergent) / 12.0) * 0.35
    )
    return {
        "primary": label or None,
        "primary_key": _sha(_normalize_text(label))[:24] if label else None,
        "keywords": sorted(tokens)[:20],
        "emergent_terms": emergent,
        "supporting_messages": supporting_messages,
        "supporting_sources": len(supporting_sources),
        "strength": round(strength, 3),
        "note": "Strength is evidence support plus model confidence, not narrative text length.",
    }


def _counterfactual(snapshot: dict[str, Any]) -> dict[str, Any]:
    nodes, edges = _graph(snapshot)
    suspicious = {
        str(row.get("id"))
        for row in nodes
        if row.get("type") == "x_account"
        and (row.get("attributes") or {}).get("suspicious") is True
    }
    actor_ids = {str(node.get("id")) for node in _actor_nodes(nodes)}
    actor_edges = [row for row in edges if str(row.get("source")) in actor_ids]
    suspicious_edges = [
        row for row in actor_edges if str(row.get("source")) in suspicious
    ]
    influence = len(suspicious_edges) / len(actor_edges) if actor_edges else 0.0
    return {
        "remove_suspicious_x": {
            "suspicious_accounts": len(suspicious),
            "actor_edges_removed": len(suspicious_edges),
            "share_of_actor_graph_removed": round(influence, 4),
            "robustness": round(1.0 - influence, 4),
        },
        "note": "Graph-only counterfactual on retained X evidence; no market outcome is recomputed.",
    }


def _anomalies(
    snapshot: dict[str, Any],
    ai_result: dict[str, Any] | None,
) -> dict[str, Any]:
    features = _feature_map(snapshot)
    mentions = _feature_number(features, "x_twitter.mentions", "x.mentions")
    authors = _feature_number(features, "x_twitter.unique_authors", "x.authors")
    engagement = _feature_number(features, "x_twitter.engagement", "x.engagement")
    tg_mentions = _feature_number(features, "telegram.mentions", "tg.mentions")
    tg_channels = _feature_number(features, "telegram.channels", "tg.channels")
    rows: list[dict[str, Any]] = []
    if mentions and authors is not None:
        ratio = authors / mentions
        if mentions >= 50 and ratio < 0.15:
            rows.append({"type": "x_low_author_diffusion", "severity": "high", "ratio": round(ratio, 4)})
    if mentions and engagement is not None:
        per_mention = engagement / mentions
        if mentions >= 20 and per_mention > 5000:
            rows.append({"type": "x_engagement_outlier", "severity": "medium", "engagement_per_mention": round(per_mention, 1)})
    if tg_mentions and tg_channels is not None:
        ratio = tg_channels / tg_mentions
        if tg_mentions >= 30 and ratio < 0.08:
            rows.append({"type": "tg_channel_concentration", "severity": "medium", "ratio": round(ratio, 4)})
    rows.extend(
        row for row in (ai_result or {}).get("anomalies") or [] if isinstance(row, dict)
    )
    return {"items": rows[:100], "count": len(rows)}


def _contradictions(
    snapshot: dict[str, Any],
    ai_result: dict[str, Any] | None,
) -> dict[str, Any]:
    features = _feature_map(snapshot)
    x_score = _feature_number(features, "scores.x", "x.score")
    tg_score = _feature_number(features, "scores.telegram", "tg.score")
    manipulation = _feature_number(features, "scores.manipulation", "combined.manipulation", "social.manipulation")
    organic = _feature_number(features, "scores.organic", "combined.organic", "social.organic")
    bot = _feature_number(features, "x_twitter.bot_risk", "x.botRisk", "x.bot_risk")
    rows: list[dict[str, Any]] = []
    if x_score is not None and tg_score is not None and abs(x_score - tg_score) >= 30:
        rows.append({"type": "cross_platform_disagreement", "severity": "medium", "values": {"x": x_score, "tg": tg_score}})
    if manipulation is not None and organic is not None and manipulation >= 70 and organic >= 70:
        rows.append({"type": "organic_manipulation_conflict", "severity": "high", "values": {"organic": organic, "manipulation": manipulation}})
    if bot is not None and x_score is not None and bot >= 65 and x_score >= 75:
        rows.append({"type": "high_x_score_high_bot_risk", "severity": "high", "values": {"x_score": x_score, "bot_risk": bot}})
    rows.extend(
        {"type": "ai_reported", **row}
        for row in (ai_result or {}).get("contradictions") or []
        if isinstance(row, dict)
    )
    return {
        "items": rows[:60],
        "count": len(rows),
        "anomaly_discovery": _anomalies(snapshot, ai_result),
    }


def _planner(snapshot: dict[str, Any], parts: dict[str, Any]) -> dict[str, Any]:
    nodes, _ = _graph(snapshot)
    identity_ids = {
        str(value)
        for row in parts["identity_resolution"]["candidates"]
        for value in (row.get("source"), row.get("target"))
        if value
    }
    candidates = []
    for node in nodes:
        node_id = str(node.get("id") or "")
        node_type = str(node.get("type") or "")
        if node_type not in {"wallet", "x_account", "tg_channel"}:
            continue
        attrs = node.get("attributes") or {}
        uncertainty = 0.5
        impact = 0.35
        novelty = 0.35
        if node_id in identity_ids:
            impact += 0.25
            uncertainty += 0.15
        if node_type == "wallet" and attrs.get("smart") is True:
            impact += 0.2
        if attrs.get("suspicious") is True or attrs.get("wash") is True:
            impact += 0.2
        if attrs.get("fresh") is None:
            uncertainty += 0.08
        score = _clamp(uncertainty * 0.4 + impact * 0.4 + novelty * 0.2)
        tools = {
            "wallet": ["expand_wallet", "funding_graph", "related_launches"],
            "x_account": ["expand_x_account", "related_launches"],
            "tg_channel": ["expand_tg_channel", "related_launches"],
        }[node_type]
        candidates.append({"entity": node_id, "entity_type": node_type, "expected_information_gain": round(score, 4), "recommended_tools": tools})
    candidates.sort(key=lambda row: row["expected_information_gain"], reverse=True)
    return {"candidates": candidates[:20]}


def _dynamic_budget(parts: dict[str, Any]) -> dict[str, Any]:
    anomaly_count = parts["contradictions"]["anomaly_discovery"]["count"]
    contradiction_count = parts["contradictions"]["count"]
    identity_count = len(parts["identity_resolution"]["candidates"])
    quality = _number(parts["evidence_quality"].get("quality")) or 0.0
    pressure = min(
        1.0,
        anomaly_count / 6
        + contradiction_count / 5
        + identity_count / 12
        + max(0.0, 0.6 - quality) * 0.35,
    )
    if pressure >= 0.7:
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
    }


def _critic_plan(parts: dict[str, Any]) -> dict[str, Any]:
    targets = []
    if parts["contradictions"]["count"]:
        targets.append("resolve deterministic contradictions")
    if parts["funding_verification"]["status"] != "evidence_available":
        targets.append("do not infer funding from similarity or co-buy timing")
    if parts["identity_resolution"]["candidates"]:
        targets.append("challenge possible_same_operator hypotheses")
    if parts["campaign_fingerprint"]["nearest_neighbors"]:
        targets.append("test whether historical campaign similarity is causal or coincidental")
    return {
        "required": bool(targets),
        "independent_pass": True,
        "targets": targets,
        "rule": "Critic receives facts and proposed conclusions, not hidden analyst reasoning.",
    }


async def _historical_context(
    session: AsyncSession,
    snapshot: dict[str, Any],
    fingerprint: dict[str, Any],
) -> dict[str, Any]:
    nodes, _ = _graph(snapshot)
    node_ids = [str(row.get("id")) for row in nodes if row.get("id")][:300]
    entities: dict[str, IntelligenceEntity] = {}
    if node_ids:
        rows = list(
            (
                await session.execute(
                    select(IntelligenceEntity).where(
                        IntelligenceEntity.entity_key.in_(node_ids)
                    )
                )
            ).scalars().all()
        )
        entities = {row.entity_key: row for row in rows}
    reliability = [
        {
            "entity": key,
            "type": row.entity_type,
            "distinct_token_occurrences": row.occurrence_count,
            "first_seen_at": row.first_seen_at.isoformat(),
            "last_seen_at": row.last_seen_at.isoformat(),
            "reliability_status": "history_available" if row.occurrence_count >= 3 else "limited_history",
        }
        for key, row in entities.items()
    ]

    current_mint = str(snapshot.get("mint") or "")
    neighbors = await find_campaign_neighbors(
        session,
        current_mint=current_mint,
        current_vector=dict(fingerprint.get("vector") or {}),
        current_actors=list(fingerprint.get("actors") or []),
    )

    hypothesis_filters = [IntelligenceHypothesisState.mint_address == current_mint]
    if node_ids:
        hypothesis_filters.extend(
            (
                IntelligenceHypothesisState.source_key.in_(node_ids),
                IntelligenceHypothesisState.target_key.in_(node_ids),
            )
        )
    hypothesis_rows = list(
        (
            await session.execute(
                select(IntelligenceHypothesisState)
                .where(or_(*hypothesis_filters))
                .order_by(IntelligenceHypothesisState.updated_at.desc())
                .limit(80)
            )
        ).scalars().all()
    )
    relevant_hypotheses = [
        {
            "hypothesis_key": row.hypothesis_key,
            "type": row.hypothesis_type,
            "source": row.source_key,
            "target": row.target_key,
            "status": row.status,
            "confidence": row.confidence,
            "support_count": row.support_count,
            "contradiction_count": row.contradiction_count,
            "updated_at": row.updated_at.isoformat(),
        }
        for row in hypothesis_rows
    ]
    negative_memory = [
        row
        for row in relevant_hypotheses
        if row["status"] in {"contradicted", "rejected"}
    ][:40]

    calibration_rows = list(
        (
            await session.execute(
                select(IntelligenceCalibrationStat)
                .order_by(IntelligenceCalibrationStat.updated_at.desc())
                .limit(200)
            )
        ).scalars().all()
    )
    calibration = []
    for row in calibration_rows:
        empirical = row.confirmed_count / row.sample_count if row.sample_count else None
        predicted = row.predicted_confidence_sum / row.sample_count if row.sample_count else None
        calibration.append(
            {
                "model_version": row.model_version,
                "signal_type": row.signal_type,
                "bucket": row.bucket,
                "samples": row.sample_count,
                "predicted": predicted,
                "empirical": empirical,
                "error": abs(predicted - empirical) if predicted is not None and empirical is not None else None,
            }
        )
    return {
        "source_reliability": sorted(reliability, key=lambda row: row["distinct_token_occurrences"], reverse=True),
        "nearest_neighbors": neighbors,
        "hypotheses": relevant_hypotheses,
        "negative_memory": negative_memory,
        "calibration": calibration,
    }


async def build_advanced_intelligence_report(
    session: AsyncSession,
    *,
    snapshot: dict[str, Any],
    ai_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    fingerprint = _campaign_fingerprint(snapshot, ai_result)
    historical = await _historical_context(session, snapshot, fingerprint)
    parts: dict[str, Any] = {
        "funding_verification": _funding_verification(snapshot),
        "wallet_clusters": _wallet_clusters(snapshot),
        "identity_resolution": _identity_resolution(snapshot),
        "temporal_graph": _temporal_graph(snapshot),
        "campaign_fingerprint": {**fingerprint, "nearest_neighbors": historical["nearest_neighbors"]},
        "text_template_clustering": _text_template_clusters(snapshot),
        "narrative_engine": _narrative(snapshot, ai_result),
        "source_reliability": historical["source_reliability"],
        "counterfactual_analysis": _counterfactual(snapshot),
        "contradictions": _contradictions(snapshot, ai_result),
        "evidence_quality": _evidence_quality(snapshot),
        "hypothesis_lifecycle": {
            "current_ai": (ai_result or {}).get("discoveredRelationships") or [],
            "historical": historical["hypotheses"],
        },
        "negative_memory": historical["negative_memory"],
    }
    parts["research_planner"] = _planner(snapshot, parts)
    parts["dynamic_research_budget"] = _dynamic_budget(parts)
    parts["dedicated_critic"] = _critic_plan(parts)
    parts["historical_nearest_neighbors"] = historical["nearest_neighbors"]
    parts["outcome_learning"] = {
        "status": "pending_future_outcome",
        "horizons_hours": [6, 24, 72],
        "leakage_rule": "Only matured future outcomes are stored; they are never injected into the originating snapshot.",
    }
    parts["ai_calibration"] = {
        "status": "history_available" if historical["calibration"] else "insufficient_history",
        "buckets": historical["calibration"],
    }
    parts["investigation_ui"] = {
        "graph_ready": True,
        "timeline_ready": bool(parts["temporal_graph"]["sequenced_edges"]),
        "sections": [
            "graph",
            "timeline",
            "actors",
            "wallet_clusters",
            "campaign_neighbors",
            "hypotheses",
            "evidence",
            "outcomes",
            "calibration",
        ],
    }
    if len(parts) != 20:
        raise RuntimeError(f"advanced intelligence contract requires 20 layers, got {len(parts)}")
    return {
        "version": ADVANCED_INTELLIGENCE_VERSION,
        "snapshot_id": snapshot.get("snapshotId"),
        "mint": snapshot.get("mint"),
        "generated_at": _now_iso(),
        "layers": parts,
        "layer_count": len(parts),
    }
