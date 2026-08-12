from __future__ import annotations

import hashlib
import json
import math
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.advanced_intelligence import (
    CampaignFingerprint,
    IntelligenceCalibrationStat,
    IntelligenceHypothesisState,
    IntelligenceNarrativeMemory,
)
from app.models.intelligence_memory import IntelligenceEdge, IntelligenceEntity

ADVANCED_INTELLIGENCE_VERSION = "advanced-intelligence-v1"
CAMPAIGN_FINGERPRINT_VERSION = "campaign-fingerprint-v1"


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
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _feature_map(snapshot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows = snapshot.get("features") or []
    return {
        str(row.get("key")): row
        for row in rows
        if isinstance(row, dict) and row.get("key")
    }


def _feature_number(features: dict[str, dict[str, Any]], *keys: str) -> float | None:
    for key in keys:
        row = features.get(key)
        if not row:
            continue
        value = _number(row.get("numericValue"))
        if value is None:
            value = _number(row.get("value"))
        if value is not None:
            return value
    return None


def _feature_text(features: dict[str, dict[str, Any]], *keys: str) -> str | None:
    for key in keys:
        row = features.get(key)
        if not row:
            continue
        value = row.get("value")
        if value not in (None, "", "—"):
            return str(value)
    return None


def _graph(snapshot: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    graph = snapshot.get("graph") or {}
    nodes = [row for row in graph.get("nodes") or [] if isinstance(row, dict)]
    edges = [row for row in graph.get("edges") or [] if isinstance(row, dict)]
    return nodes, edges


def _normalize_text(text: str) -> str:
    value = text.lower()
    value = re.sub(r"https?://\S+", " ", value)
    value = re.sub(r"[1-9A-HJ-NP-Za-km-z]{32,44}", " ", value)
    value = re.sub(r"[^\w\s]+", " ", value, flags=re.UNICODE)
    return " ".join(value.split())[:400]


def _jaccard(left: set[str], right: set[str]) -> float:
    if not left and not right:
        return 1.0
    union = left | right
    return len(left & right) / len(union) if union else 0.0


def _cosine_dict(left: dict[str, float], right: dict[str, float]) -> float:
    keys = set(left) | set(right)
    dot = sum(left.get(key, 0.0) * right.get(key, 0.0) for key in keys)
    norm_l = math.sqrt(sum(value * value for value in left.values()))
    norm_r = math.sqrt(sum(value * value for value in right.values()))
    if norm_l == 0 or norm_r == 0:
        return 0.0
    return dot / (norm_l * norm_r)


def _actor_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row for row in nodes if row.get("type") in {"x_account", "tg_channel"}]


def _wallet_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row for row in nodes if row.get("type") == "wallet"]


def _evidence_quality(snapshot: dict[str, Any]) -> dict[str, Any]:
    nodes, edges = _graph(snapshot)
    evidence = snapshot.get("evidence") or []
    counts = Counter()
    weighted = 0.0
    total = 0
    for edge in edges:
        edge_type = str(edge.get("type") or "")
        if edge_type in {"trades", "bundle_member"}:
            grade, weight = "verified_onchain", 1.0
        elif edge_type in {"mentions", "calls", "shared_link", "mentions_wallet"}:
            grade, weight = "direct_source", 0.86
        elif edge_type in {"copies", "amplifies"}:
            grade, weight = "derived", 0.68
        else:
            grade, weight = "derived", 0.55
        counts[grade] += 1
        weighted += weight
        total += 1
    memory_features = [
        row for row in snapshot.get("features") or []
        if str(row.get("key") or "").startswith("memory.")
    ]
    research_features = [
        row for row in snapshot.get("features") or []
        if str(row.get("key") or "").startswith("research.")
    ]
    if memory_features:
        counts["historical_prior"] += len(memory_features)
        weighted += 0.5 * len(memory_features)
        total += len(memory_features)
    if research_features:
        counts["research_derived"] += len(research_features)
        weighted += 0.75 * len(research_features)
        total += len(research_features)
    coverage = min(1.0, (len(evidence) + len(edges)) / 80.0)
    quality = weighted / total if total else 0.0
    return {
        "score": round(100 * (quality * 0.7 + coverage * 0.3), 1),
        "quality": round(quality, 4),
        "coverage": round(coverage, 4),
        "classes": dict(counts),
        "evidence_items": len(evidence),
        "graph_edges": len(edges),
        "nodes": len(nodes),
    }


def _funding_verification(snapshot: dict[str, Any]) -> dict[str, Any]:
    features = snapshot.get("features") or []
    explicit: list[dict[str, Any]] = []
    similarity_only: list[dict[str, Any]] = []
    for row in features:
        key = str(row.get("key") or "")
        value = str(row.get("value") or "")
        if not key.startswith("research.funding_graph."):
            continue
        try:
            payload = json.loads(value)
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        explicit.extend(payload.get("explicit_funding_evidence") or [])
        similarity_only.extend(payload.get("similarity_links_not_funding_proof") or [])
    if explicit:
        return {
            "status": "evidence_available",
            "explicit_edges": explicit[:30],
            "similarity_only": similarity_only[:30],
            "verified_by_rpc": False,
            "note": "Collector-stored transfer/funding evidence; RPC verification remains a separate step.",
        }
    return {
        "status": "insufficient_data",
        "explicit_edges": [],
        "similarity_only": similarity_only[:30],
        "verified_by_rpc": False,
        "note": "Similarity/shared-token links are not treated as funding proof.",
    }


def _wallet_clusters(snapshot: dict[str, Any]) -> dict[str, Any]:
    nodes, edges = _graph(snapshot)
    wallet_ids = {str(row.get("id")) for row in _wallet_nodes(nodes)}
    adjacency: dict[str, set[str]] = defaultdict(set)
    reasons: dict[tuple[str, str], list[str]] = defaultdict(list)
    bundle_members: dict[str, list[str]] = defaultdict(list)
    for edge in edges:
        source, target = str(edge.get("source")), str(edge.get("target"))
        edge_type = str(edge.get("type") or "")
        if edge_type == "bundle_member" and source in wallet_ids:
            bundle_members[target].append(source)
    for members in bundle_members.values():
        for index, left in enumerate(members):
            for right in members[index + 1 :]:
                adjacency[left].add(right)
                adjacency[right].add(left)
                reasons[tuple(sorted((left, right)))].append("same_bundle")
    visited: set[str] = set()
    clusters: list[dict[str, Any]] = []
    for wallet in sorted(wallet_ids):
        if wallet in visited:
            continue
        stack, group = [wallet], []
        while stack:
            current = stack.pop()
            if current in visited:
                continue
            visited.add(current)
            group.append(current)
            stack.extend(adjacency[current] - visited)
        if len(group) > 1:
            clusters.append({
                "cluster_id": f"wallet_cluster:{_sha(sorted(group))[:16]}",
                "members": sorted(group),
                "confidence": 0.94,
                "reasons": ["same_bundle"],
                "status": "strong_candidate_cluster",
            })
    return {
        "clusters": clusters,
        "unclustered_wallets": len(wallet_ids) - sum(len(row["members"]) for row in clusters),
        "method": "strong deterministic links only; no shared-owner claim",
    }


def _identity_resolution(snapshot: dict[str, Any]) -> dict[str, Any]:
    nodes, edges = _graph(snapshot)
    actors = {str(row.get("id")): row for row in _actor_nodes(nodes)}
    shared: dict[tuple[str, str], set[str]] = defaultdict(set)
    target_to_actors: dict[str, set[str]] = defaultdict(set)
    for edge in edges:
        source, target = str(edge.get("source")), str(edge.get("target"))
        if source not in actors:
            continue
        if edge.get("type") in {"shared_link", "mentions_wallet"}:
            target_to_actors[target].add(source)
    for target, actor_ids in target_to_actors.items():
        ordered = sorted(actor_ids)
        for index, left in enumerate(ordered):
            for right in ordered[index + 1 :]:
                shared[(left, right)].add(target)
    candidates = []
    for (left, right), targets in shared.items():
        confidence = min(0.82, 0.35 + 0.18 * len(targets))
        candidates.append({
            "source": left,
            "target": right,
            "relationship": "possible_same_operator",
            "confidence": round(confidence, 3),
            "shared_targets": sorted(targets)[:20],
            "status": "hypothesis",
            "note": "Shared links/wallet mentions do not prove common identity.",
        })
    return {"candidates": sorted(candidates, key=lambda row: row["confidence"], reverse=True)[:50]}


def _temporal_graph(snapshot: dict[str, Any]) -> dict[str, Any]:
    _, edges = _graph(snapshot)
    rows = []
    for edge in edges:
        attrs = edge.get("attributes") or {}
        lag = _number(attrs.get("lagSeconds"))
        if lag is None:
            continue
        rows.append({
            "source": edge.get("source"),
            "target": edge.get("target"),
            "type": edge.get("type"),
            "lag_seconds": lag,
            "confidence": edge.get("confidence"),
        })
    rows.sort(key=lambda row: abs(row["lag_seconds"]))
    return {
        "sequenced_edges": rows[:100],
        "median_abs_lag_seconds": (
            sorted(abs(row["lag_seconds"]) for row in rows)[len(rows) // 2] if rows else None
        ),
    }


def _campaign_vector(snapshot: dict[str, Any]) -> dict[str, float]:
    nodes, edges = _graph(snapshot)
    features = _feature_map(snapshot)
    types = Counter(str(row.get("type") or "unknown") for row in nodes)
    edge_types = Counter(str(row.get("type") or "unknown") for row in edges)
    return {
        "x_accounts": float(types["x_account"]),
        "tg_channels": float(types["tg_channel"]),
        "wallets": float(types["wallet"]),
        "bundles": float(types["bundle"]),
        "shared_links": float(edge_types["shared_link"]),
        "copies": float(edge_types["copies"]),
        "amplifies": float(edge_types["amplifies"]),
        "mentions_wallet": float(edge_types["mentions_wallet"]),
        "social_score": _feature_number(features, "combined.social_score", "social.score") or 0.0,
        "organic": _feature_number(features, "combined.organic", "social.organic") or 0.0,
        "manipulation": _feature_number(features, "combined.manipulation", "social.manipulation") or 0.0,
        "early": _feature_number(features, "combined.early", "social.early") or 0.0,
        "alpha": _feature_number(features, "combined.alpha", "social.alpha") or 0.0,
    }


def _campaign_fingerprint(snapshot: dict[str, Any], ai_result: dict[str, Any] | None) -> dict[str, Any]:
    nodes, edges = _graph(snapshot)
    vector = _campaign_vector(snapshot)
    actors = sorted(row.get("id") for row in _actor_nodes(nodes) if row.get("id"))
    link_targets = sorted(
        str(edge.get("target")) for edge in edges if edge.get("type") == "shared_link"
    )
    narrative = str((ai_result or {}).get("campaignHypothesis", {}).get("narrative") or "").strip()
    payload = {
        "version": CAMPAIGN_FINGERPRINT_VERSION,
        "vector": vector,
        "actors": actors,
        "links": link_targets,
        "narrative": _normalize_text(narrative),
    }
    return {**payload, "hash": _sha(payload)}


def _text_template_clusters(snapshot: dict[str, Any]) -> dict[str, Any]:
    evidence = [row for row in snapshot.get("evidence") or [] if isinstance(row, dict)]
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in evidence:
        normalized = _normalize_text(str(row.get("text") or ""))
        if len(normalized) < 20:
            continue
        groups[normalized].append(row)
    clusters = []
    for template, rows in groups.items():
        sources = sorted({str(row.get("source") or "unknown") for row in rows})
        if len(rows) < 2 or len(sources) < 2:
            continue
        clusters.append({
            "template_hash": _sha(template)[:20],
            "sample": template[:220],
            "messages": len(rows),
            "sources": sources,
            "confidence": min(0.98, 0.7 + 0.05 * len(rows)),
        })
    clusters.sort(key=lambda row: (row["messages"], len(row["sources"])), reverse=True)
    return {"clusters": clusters[:50], "semantic_embeddings_enabled": False}


def _narrative(snapshot: dict[str, Any], ai_result: dict[str, Any] | None) -> dict[str, Any]:
    result = ai_result or {}
    campaign = result.get("campaignHypothesis") or {}
    label = str(campaign.get("narrative") or "").strip()
    tokens = [token for token in _normalize_text(label).split() if len(token) > 2]
    evidence_text = " ".join(str(row.get("text") or "") for row in snapshot.get("evidence") or [])
    frequencies = Counter(token for token in _normalize_text(evidence_text).split() if len(token) > 3)
    emergent = [word for word, count in frequencies.most_common(12) if count >= 2]
    return {
        "primary": label or None,
        "primary_key": _sha(_normalize_text(label))[:24] if label else None,
        "keywords": tokens[:20],
        "emergent_terms": emergent,
        "strength": round(min(1.0, (len(tokens) / 12.0) + (len(emergent) / 20.0)), 3),
    }


def _counterfactual(snapshot: dict[str, Any]) -> dict[str, Any]:
    nodes, edges = _graph(snapshot)
    x_nodes = [row for row in nodes if row.get("type") == "x_account"]
    suspicious = {
        str(row.get("id"))
        for row in x_nodes
        if bool((row.get("attributes") or {}).get("suspicious"))
    }
    actor_edges = [row for row in edges if str(row.get("source")) in {str(n.get("id")) for n in _actor_nodes(nodes)}]
    suspicious_edges = [row for row in actor_edges if str(row.get("source")) in suspicious]
    influence = len(suspicious_edges) / len(actor_edges) if actor_edges else 0.0
    return {
        "remove_suspicious_x": {
            "suspicious_accounts": len(suspicious),
            "actor_edges_removed": len(suspicious_edges),
            "share_of_actor_graph_removed": round(influence, 4),
            "robustness": round(1.0 - influence, 4),
        },
        "note": "Graph robustness counterfactual; does not recompute market outcome.",
    }


def _contradictions(snapshot: dict[str, Any], ai_result: dict[str, Any] | None) -> dict[str, Any]:
    features = _feature_map(snapshot)
    rows: list[dict[str, Any]] = []
    x_score = _feature_number(features, "x.score")
    tg_score = _feature_number(features, "tg.score")
    manipulation = _feature_number(features, "combined.manipulation", "social.manipulation")
    organic = _feature_number(features, "combined.organic", "social.organic")
    bot = _feature_number(features, "x.botRisk", "x.bot_risk")
    if x_score is not None and tg_score is not None and abs(x_score - tg_score) >= 30:
        rows.append({"type": "cross_platform_disagreement", "severity": "medium", "values": {"x": x_score, "tg": tg_score}})
    if manipulation is not None and organic is not None and manipulation >= 70 and organic >= 70:
        rows.append({"type": "organic_manipulation_conflict", "severity": "high", "values": {"organic": organic, "manipulation": manipulation}})
    if bot is not None and x_score is not None and bot >= 65 and x_score >= 75:
        rows.append({"type": "high_x_score_high_bot_risk", "severity": "high", "values": {"x_score": x_score, "bot_risk": bot}})
    for row in (ai_result or {}).get("contradictions") or []:
        rows.append({"type": "ai_reported", **row})
    return {"items": rows[:60], "count": len(rows)}


def _anomalies(snapshot: dict[str, Any], ai_result: dict[str, Any] | None) -> dict[str, Any]:
    features = _feature_map(snapshot)
    rows: list[dict[str, Any]] = []
    mentions = _feature_number(features, "x.mentions")
    authors = _feature_number(features, "x.authors")
    engagement = _feature_number(features, "x.engagement")
    tg_mentions = _feature_number(features, "tg.mentions")
    tg_channels = _feature_number(features, "tg.channels")
    if mentions and authors is not None and mentions >= 50 and authors / mentions < 0.15:
        rows.append({"type": "x_low_author_diffusion", "severity": "high", "ratio": round(authors / mentions, 4)})
    if mentions and engagement is not None and mentions >= 20 and engagement / mentions > 5000:
        rows.append({"type": "x_engagement_outlier", "severity": "medium", "engagement_per_mention": round(engagement / mentions, 1)})
    if tg_mentions and tg_channels is not None and tg_mentions >= 30 and tg_channels / tg_mentions < 0.08:
        rows.append({"type": "tg_channel_concentration", "severity": "medium", "ratio": round(tg_channels / tg_mentions, 4)})
    rows.extend((ai_result or {}).get("anomalies") or [])
    return {"items": rows[:100], "count": len(rows)}


def _planner(snapshot: dict[str, Any], report_parts: dict[str, Any]) -> dict[str, Any]:
    nodes, _ = _graph(snapshot)
    candidates = []
    identity_ids = {
        row.get("source") for row in report_parts["identity_resolution"]["candidates"]
    } | {
        row.get("target") for row in report_parts["identity_resolution"]["candidates"]
    }
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
        if node_type == "wallet" and attrs.get("smart"):
            impact += 0.2
        if attrs.get("suspicious") or attrs.get("wash"):
            impact += 0.2
        score = _clamp(uncertainty * 0.4 + impact * 0.4 + novelty * 0.2)
        candidates.append({
            "entity": node_id,
            "entity_type": node_type,
            "expected_information_gain": round(score, 4),
            "recommended_tools": {
                "wallet": ["expand_wallet", "funding_graph", "related_launches"],
                "x_account": ["expand_x_account", "related_launches"],
                "tg_channel": ["expand_tg_channel", "related_launches"],
            }[node_type],
        })
    candidates.sort(key=lambda row: row["expected_information_gain"], reverse=True)
    return {"candidates": candidates[:20]}


def _dynamic_budget(report_parts: dict[str, Any]) -> dict[str, Any]:
    anomaly_count = report_parts["anomalies"]["count"]
    contradiction_count = report_parts["contradictions"]["count"]
    identity_count = len(report_parts["identity_resolution"]["candidates"])
    pressure = min(1.0, anomaly_count / 6 + contradiction_count / 5 + identity_count / 12)
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


def _critic_plan(report_parts: dict[str, Any]) -> dict[str, Any]:
    targets = []
    if report_parts["contradictions"]["count"]:
        targets.append("resolve deterministic contradictions")
    if report_parts["funding_verification"]["status"] != "evidence_available":
        targets.append("do not infer funding from wallet similarity")
    if report_parts["identity_resolution"]["candidates"]:
        targets.append("challenge possible_same_operator hypotheses")
    if report_parts["campaign_fingerprint"]["nearest_neighbors"]:
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
        rows = list((await session.execute(select(IntelligenceEntity).where(IntelligenceEntity.entity_key.in_(node_ids)))).scalars().all())
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

    prior = list((await session.execute(select(CampaignFingerprint).order_by(CampaignFingerprint.created_at.desc()).limit(500))).scalars().all())
    current_vector = {key: float(value) for key, value in fingerprint["vector"].items() if _number(value) is not None}
    actor_set = set(fingerprint["actors"])
    neighbors = []
    for row in prior:
        if row.snapshot_id == snapshot.get("snapshotId"):
            continue
        previous_vector = {key: float(value) for key, value in (row.vector or {}).items() if _number(value) is not None}
        vector_similarity = _cosine_dict(current_vector, previous_vector)
        actor_similarity = _jaccard(actor_set, set(row.actors or []))
        similarity = vector_similarity * 0.72 + actor_similarity * 0.28
        if similarity < 0.45:
            continue
        neighbors.append({
            "snapshot_id": row.snapshot_id,
            "mint": row.mint_address,
            "similarity": round(similarity, 4),
            "vector_similarity": round(vector_similarity, 4),
            "actor_similarity": round(actor_similarity, 4),
            "created_at": row.created_at.isoformat(),
        })
    neighbors.sort(key=lambda row: row["similarity"], reverse=True)

    negative = list((await session.execute(select(IntelligenceHypothesisState).where(IntelligenceHypothesisState.status.in_(["contradicted", "rejected"])).order_by(IntelligenceHypothesisState.updated_at.desc()).limit(100))).scalars().all())
    negative_memory = [
        {
            "hypothesis_key": row.hypothesis_key,
            "type": row.hypothesis_type,
            "source": row.source_key,
            "target": row.target_key,
            "status": row.status,
            "confidence": row.confidence,
            "contradiction_count": row.contradiction_count,
        }
        for row in negative
        if not row.source_key or row.source_key in node_ids or not row.target_key or row.target_key in node_ids
    ][:40]

    calibration_rows = list((await session.execute(select(IntelligenceCalibrationStat).order_by(IntelligenceCalibrationStat.updated_at.desc()).limit(200))).scalars().all())
    calibration = []
    for row in calibration_rows:
        empirical = row.confirmed_count / row.sample_count if row.sample_count else None
        predicted = row.predicted_confidence_sum / row.sample_count if row.sample_count else None
        calibration.append({
            "model_version": row.model_version,
            "signal_type": row.signal_type,
            "bucket": row.bucket,
            "samples": row.sample_count,
            "predicted": predicted,
            "empirical": empirical,
            "error": abs(predicted - empirical) if predicted is not None and empirical is not None else None,
        })
    return {
        "source_reliability": sorted(reliability, key=lambda row: row["distinct_token_occurrences"], reverse=True),
        "nearest_neighbors": neighbors[:10],
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
        "hypothesis_lifecycle": {"current": (ai_result or {}).get("discoveredRelationships") or []},
        "negative_memory": historical["negative_memory"],
    }
    parts["anomalies"] = _anomalies(snapshot, ai_result)
    parts["research_planner"] = _planner(snapshot, parts)
    parts["dynamic_research_budget"] = _dynamic_budget(parts)
    parts["dedicated_critic"] = _critic_plan(parts)
    parts["historical_nearest_neighbors"] = historical["nearest_neighbors"]
    parts["outcome_learning"] = {
        "status": "pending_future_outcome",
        "horizons_hours": [6, 24, 72],
        "leakage_rule": "Outcome is stored after horizon maturity and never injected into the original snapshot.",
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
    return {
        "version": ADVANCED_INTELLIGENCE_VERSION,
        "snapshot_id": snapshot.get("snapshotId"),
        "mint": snapshot.get("mint"),
        "generated_at": _now_iso(),
        "layers": parts,
        "layer_count": 20,
    }


async def persist_advanced_intelligence(
    session: AsyncSession,
    *,
    snapshot: dict[str, Any],
    report: dict[str, Any],
    ai_result: dict[str, Any] | None = None,
) -> None:
    snapshot_id = str(snapshot.get("snapshotId") or "")
    mint = str(snapshot.get("mint") or "")
    fingerprint = report["layers"]["campaign_fingerprint"]
    existing = (
        await session.execute(select(CampaignFingerprint).where(CampaignFingerprint.snapshot_id == snapshot_id))
    ).scalar_one_or_none()
    if existing is None:
        session.add(CampaignFingerprint(
            snapshot_id=snapshot_id,
            mint_address=mint,
            fingerprint_hash=fingerprint["hash"],
            vector=fingerprint["vector"],
            actors=fingerprint["actors"],
            narratives=[report["layers"]["narrative_engine"]],
        ))

    narrative = report["layers"]["narrative_engine"]
    if narrative.get("primary_key") and narrative.get("primary"):
        row = (
            await session.execute(select(IntelligenceNarrativeMemory).where(IntelligenceNarrativeMemory.narrative_key == narrative["primary_key"]))
        ).scalar_one_or_none()
        actor_keys = fingerprint.get("actors") or []
        if row is None:
            session.add(IntelligenceNarrativeMemory(
                narrative_key=narrative["primary_key"],
                label=narrative["primary"][:500],
                occurrence_count=1,
                token_mints=[mint],
                actor_keys=actor_keys[:100],
                examples=[narrative.get("primary")],
            ))
        else:
            mints = list(dict.fromkeys([*(row.token_mints or []), mint]))[:500]
            actors = list(dict.fromkeys([*(row.actor_keys or []), *actor_keys]))[:500]
            row.occurrence_count = len(mints)
            row.token_mints = mints
            row.actor_keys = actors
            row.last_seen_at = datetime.now(timezone.utc)

    for discovery in (ai_result or {}).get("discoveredRelationships") or []:
        source = str(discovery.get("source") or "") or None
        target = str(discovery.get("target") or "") or None
        dtype = str(discovery.get("type") or "other")
        key = _sha({"type": dtype, "source": source, "target": target})[:64]
        row = (
            await session.execute(select(IntelligenceHypothesisState).where(IntelligenceHypothesisState.hypothesis_key == key))
        ).scalar_one_or_none()
        status = str(discovery.get("status") or "hypothesis")
        confidence = _clamp(_number(discovery.get("confidence")) or 0.0)
        evidence = [*(discovery.get("evidenceMessageIds") or []), *(discovery.get("supportingFeatureKeys") or [])]
        if row is None:
            session.add(IntelligenceHypothesisState(
                hypothesis_key=key,
                mint_address=mint,
                hypothesis_type=dtype,
                source_key=source,
                target_key=target,
                status=status,
                confidence=confidence,
                support_count=1 if status in {"supported", "hypothesis"} else 0,
                contradiction_count=1 if status in {"contradicted", "rejected"} else 0,
                evidence=evidence[:100],
                payload=discovery,
            ))
        else:
            if status in {"supported", "hypothesis"}:
                row.support_count += 1
            if status in {"contradicted", "rejected"}:
                row.contradiction_count += 1
            total = row.support_count + row.contradiction_count
            row.confidence = (
                (row.confidence * max(1, total - 1) + confidence) / max(1, total)
            )
            if row.contradiction_count > row.support_count:
                row.status = "contradicted"
            elif row.support_count >= 3 and row.confidence >= 0.7:
                row.status = "strengthened"
            else:
                row.status = status
            row.evidence = list(dict.fromkeys([*(row.evidence or []), *evidence]))[-200:]
            row.payload = discovery
            row.updated_at = datetime.now(timezone.utc)
    await session.commit()
