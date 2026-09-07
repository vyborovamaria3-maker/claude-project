from __future__ import annotations

import math
import re
from collections import Counter
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models.advanced_intelligence import IntelligenceEntityOutcomeProjection
from app.services.solana_funding_verifier import verify_snapshot_wallet_funding


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


def semantic_template_clusters(snapshot: dict[str, Any]) -> dict[str, Any]:
    evidence = [
        row
        for row in snapshot.get("evidence") or []
        if isinstance(row, dict)
    ][:160]
    prepared = []
    for row in evidence:
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
        pair_scores: list[float] = []
        for other_index in range(index + 1, len(prepared)):
            if other_index in assigned:
                continue
            other = prepared[other_index]
            if row["source"] == other["source"]:
                continue
            similarity = _semantic_similarity(row["text"], other["text"])
            if similarity < 0.72:
                continue
            members.append(other_index)
            pair_scores.append(similarity)
        sources = {prepared[item]["source"] for item in members}
        if len(members) < 2 or len(sources) < 2:
            continue
        assigned.update(members)
        average_similarity = (
            sum(pair_scores) / len(pair_scores) if pair_scores else 1.0
        )
        clusters.append(
            {
                "cluster_id": f"semantic-template-{index}",
                "sample": prepared[index]["normalized"][:240],
                "messages": len(members),
                "sources": sorted(sources),
                "evidence_ids": [
                    prepared[item]["id"]
                    for item in members
                    if prepared[item]["id"]
                ][:30],
                "average_similarity": round(average_similarity, 4),
                "confidence": round(
                    min(0.95, 0.45 + average_similarity * 0.45),
                    4,
                ),
            }
        )
    clusters.sort(
        key=lambda row: (row["messages"], row["average_similarity"]),
        reverse=True,
    )
    return {
        "method": "token-jaccard+character-trigram-cosine-v2",
        "semantic_embeddings_enabled": False,
        "clusters": clusters[:50],
        "threshold": 0.72,
        "note": (
            "Deterministic semantic-like similarity on retained evidence. "
            "It is a coordination clue, not proof of common authorship."
        ),
    }


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
        and row.get("id")
    ][:120]
    if not actor_ids:
        return base_rows

    # One prepared row per entity + token + horizon. The outcome-learning worker
    # maintains this projection when a 72h outcome matures, so the hot report
    # path no longer rebuilds a cross-table earliest-snapshot join every time.
    projected = list(
        (
            await session.execute(
                select(
                    IntelligenceEntityOutcomeProjection.entity_key,
                    IntelligenceEntityOutcomeProjection.mint_address,
                    IntelligenceEntityOutcomeProjection.max_multiple,
                    IntelligenceEntityOutcomeProjection.max_drawdown_pct,
                ).where(
                    IntelligenceEntityOutcomeProjection.entity_key.in_(actor_ids),
                    IntelligenceEntityOutcomeProjection.horizon_hours == 72,
                    IntelligenceEntityOutcomeProjection.max_multiple.is_not(None),
                )
            )
        ).all()
    )

    per_entity: dict[str, dict[str, Any]] = {}
    for row in projected:
        bucket = per_entity.setdefault(
            str(row.entity_key),
            {
                "matured_mints": set(),
                "wins": 0,
                "collapses": 0,
                "multiples": [],
            },
        )
        mint = str(row.mint_address)
        if mint in bucket["matured_mints"]:
            continue
        bucket["matured_mints"].add(mint)
        multiple = float(row.max_multiple)
        bucket["wins"] += int(multiple >= 2)
        bucket["collapses"] += int(
            row.max_drawdown_pct is not None
            and float(row.max_drawdown_pct) <= -80
        )
        bucket["multiples"].append(multiple)

    base_by_entity = {str(row.get("entity")): row for row in base_rows}
    enriched = []
    for entity in actor_ids:
        base = dict(base_by_entity.get(entity) or {"entity": entity})
        stats = per_entity.get(entity) or {}
        matured_mints = stats.get("matured_mints") or set()
        matured = len(matured_mints)
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
                "matured_72h_samples": matured,
                "historical_2x_rate_72h": (
                    round(stats.get("wins", 0) / matured, 4)
                    if matured
                    else None
                ),
                "historical_collapse_rate_72h": (
                    round(stats.get("collapses", 0) / matured, 4)
                    if matured
                    else None
                ),
                "median_max_multiple_72h": median_multiple,
                "performance_status": (
                    "calibrated_history"
                    if matured >= 10
                    else "limited_outcome_history"
                ),
                "selection_rule": "earliest_snapshot_per_entity_and_mint",
                "performance_source": "intelligence_entity_outcomes_projection",
                "causality_note": (
                    "Historical association only; actor presence is not proven "
                    "to cause the outcome."
                ),
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
    stored = dict(layers.get("funding_verification") or {})
    initial_edges = funding.get("initial_funding_edges") or []
    stored.update(
        {
            "rpc": funding,
            "verified_by_rpc": bool(initial_edges),
            "verified_edges": initial_edges,
            "observed_incoming_transfers": (
                funding.get("observed_incoming_transfers") or []
            ),
            "same_funder_groups": funding.get("same_funder_groups") or [],
            "status": (
                "rpc_verified_initial_funding"
                if initial_edges
                else stored.get("status", "insufficient_data")
            ),
            "ownership_claim": False,
        }
    )
    layers["funding_verification"] = stored

    layers["text_template_clustering"] = semantic_template_clusters(snapshot)
    layers["source_reliability"] = await performance_aware_source_reliability(
        session,
        snapshot,
        list(layers.get("source_reliability") or []),
    )

    # The base engine owns campaign/evidence/contradiction/narrative semantics.
    # Enrichment must never silently replace those deterministic contracts.
    critic = dict(layers.get("dedicated_critic") or {})
    targets = list(critic.get("targets") or [])
    if not initial_edges:
        warning = "do not infer funding or common control without initial-funding proof"
        if warning not in targets:
            targets.append(warning)
    critic["required"] = bool(targets)
    critic["targets"] = targets
    critic["independent_pass"] = True
    critic["rule"] = (
        "Critic receives facts and proposed conclusions, not hidden analyst reasoning."
    )
    layers["dedicated_critic"] = critic

    report["layers"] = layers
    report["layer_count"] = len(layers)
    if report["layer_count"] != 20:
        raise RuntimeError(
            f"advanced intelligence contract requires 20 layers, got {report['layer_count']}"
        )
    return report
