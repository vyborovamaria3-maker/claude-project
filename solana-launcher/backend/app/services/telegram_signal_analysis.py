from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
import re
from statistics import mean, median
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.social_intelligence import SocialEvent, TelegramCall, TelegramChannel, TelegramMessage
from app.services.social_intelligence import normalize_caller_username, score_channel_metrics


_URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
_SOLANA_LIKE_RE = re.compile(r"[1-9A-HJ-NP-Za-km-z]{32,44}")
_EVM_LIKE_RE = re.compile(r"0x[0-9a-fA-F]{40}")
_WORD_RE = re.compile(r"[a-z0-9_$]{2,}", re.IGNORECASE)
_COORDINATION_WINDOW_SECONDS = 15 * 60
_HIGH_SIMILARITY = 0.72
_OUTCOME_WINDOW_LABELS = ("5m", "15m", "1h", "4h", "24h")


def _aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _clamp(value: float) -> float:
    return max(0.0, min(100.0, value))


def _finite(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed and abs(parsed) != float("inf") else None


def _normalized_tokens(text: str) -> set[str]:
    value = _URL_RE.sub(" ", text or "")
    value = _EVM_LIKE_RE.sub(" CONTRACT ", value)
    value = _SOLANA_LIKE_RE.sub(" MINT ", value)
    stop = {
        "the",
        "and",
        "for",
        "this",
        "that",
        "with",
        "from",
        "https",
        "http",
        "mint",
        "contract",
    }
    return {token.lower() for token in _WORD_RE.findall(value) if token.lower() not in stop}


def _jaccard(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    union = left | right
    if not union:
        return 0.0
    return len(left & right) / len(union)


def _forwarded_from(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("forwarded_from") or "").strip().lower().lstrip("@")


def _window(meta: Any, label: str) -> dict[str, Any] | None:
    if not isinstance(meta, dict):
        return None
    windows = meta.get("outcome_windows")
    if not isinstance(windows, dict):
        return None
    value = windows.get(label)
    return value if isinstance(value, dict) else None


def _temporal_outcome_profile(rows: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    materialized = list(rows)
    profile: dict[str, dict[str, Any]] = {}
    for label in _OUTCOME_WINDOW_LABELS:
        samples: list[tuple[float, float]] = []
        for row in materialized:
            window = _window(row.get("meta"), label)
            if not window or not window.get("complete"):
                continue
            close = _finite(window.get("close_multiple"))
            peak = _finite(window.get("peak_multiple"))
            if close is None or peak is None:
                continue
            samples.append((close, peak))
        closes = [item[0] for item in samples]
        peaks = [item[1] for item in samples]
        profile[label] = {
            "samples": len(samples),
            "median_close_multiple": round(median(closes), 4) if closes else None,
            "median_peak_multiple": round(median(peaks), 4) if peaks else None,
            "positive_close_rate": round(sum(value > 1 for value in closes) / len(closes), 4) if closes else None,
            "two_x_rate": round(sum(value >= 2 for value in peaks) / len(peaks), 4) if peaks else None,
        }
    return profile


def _temporal_outcome_score(profile: dict[str, dict[str, Any]]) -> float | None:
    weighted: list[tuple[float, float]] = []
    for label, weight in (("15m", 0.15), ("1h", 0.35), ("4h", 0.25), ("24h", 0.25)):
        row = profile.get(label) or {}
        samples = int(row.get("samples") or 0)
        positive = _finite(row.get("positive_close_rate"))
        two_x = _finite(row.get("two_x_rate"))
        if samples <= 0 or (positive is None and two_x is None):
            continue
        value = _clamp((positive or 0.0) * 65.0 + (two_x or 0.0) * 35.0)
        reliability = min(1.0, samples / 12.0)
        weighted.append((value, weight * max(0.25, reliability)))
    denominator = sum(weight for _, weight in weighted)
    if denominator <= 0:
        return None
    return sum(value * weight for value, weight in weighted) / denominator


def analyze_coordination_events(events: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Estimate how many Telegram sources are independent vs repost/coordinated."""

    earliest_by_source: dict[str, dict[str, Any]] = {}
    for raw in events:
        source = str(raw.get("source_handle") or "").strip().lower().lstrip("@")
        occurred = raw.get("occurred_at")
        if not source or not isinstance(occurred, datetime):
            continue
        item = dict(raw)
        item["source_handle"] = source
        item["occurred_at"] = _aware(occurred)
        previous = earliest_by_source.get(source)
        if previous is None or item["occurred_at"] < previous["occurred_at"]:
            earliest_by_source[source] = item

    rows = sorted(earliest_by_source.values(), key=lambda item: item["occurred_at"])
    total = len(rows)
    if not rows:
        return {
            "sources": 0,
            "independent_sources": 0,
            "coordinated_sources": 0,
            "source_independence_score": 0.0,
            "coordination_risk": 0.0,
            "leader": None,
            "spread_minutes": None,
            "burst_sources_5m": 0,
            "clusters": [],
        }

    parents = list(range(total))
    coordinated: set[int] = set()
    tokens = [_normalized_tokens(str(row.get("text") or "")) for row in rows]

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(left: int, right: int) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root != right_root:
            parents[right_root] = left_root

    for index, row in enumerate(rows):
        forwarded = _forwarded_from(row.get("payload"))
        best_index: int | None = None
        best_similarity = 0.0
        for previous in range(index - 1, -1, -1):
            delta = (row["occurred_at"] - rows[previous]["occurred_at"]).total_seconds()
            if delta > _COORDINATION_WINDOW_SECONDS:
                break
            previous_source = str(rows[previous].get("source_handle") or "")
            if forwarded and (
                forwarded == previous_source
                or previous_source in forwarded
                or forwarded in previous_source
            ):
                best_index = previous
                best_similarity = 1.0
                break
            similarity = _jaccard(tokens[index], tokens[previous])
            if similarity > best_similarity:
                best_similarity = similarity
                best_index = previous
        if forwarded:
            coordinated.add(index)
        if best_index is not None and best_similarity >= _HIGH_SIMILARITY:
            union(best_index, index)
            coordinated.add(index)

    clusters_by_root: dict[int, list[int]] = defaultdict(list)
    for index in range(total):
        clusters_by_root[find(index)].append(index)

    first_time = rows[0]["occurred_at"]
    burst_5m = sum(
        1
        for row in rows
        if (row["occurred_at"] - first_time).total_seconds() <= 5 * 60
    )
    coordinated_count = len(coordinated)
    coordination_ratio = coordinated_count / total
    burst_ratio = max(0.0, (burst_5m - 1) / max(1, total - 1))
    coordination_risk = _clamp(coordination_ratio * 75.0 + burst_ratio * 25.0)
    independent_estimate = max(1, total - coordinated_count)

    clusters = []
    for indices in sorted(clusters_by_root.values(), key=lambda group: rows[group[0]]["occurred_at"]):
        clusters.append(
            {
                "leader": rows[indices[0]]["source_handle"],
                "sources": [rows[index]["source_handle"] for index in indices],
                "size": len(indices),
            }
        )

    spread_minutes = (
        rows[-1]["occurred_at"] - rows[0]["occurred_at"]
    ).total_seconds() / 60.0
    return {
        "sources": total,
        "independent_sources": independent_estimate,
        "coordinated_sources": coordinated_count,
        "source_independence_score": round(100.0 - coordination_risk, 1),
        "coordination_risk": round(coordination_risk, 1),
        "leader": rows[0]["source_handle"],
        "spread_minutes": round(spread_minutes, 2),
        "burst_sources_5m": burst_5m,
        "clusters": clusters,
    }


def build_caller_reputation(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Build caller reputation from chronology, legacy outcomes, temporal windows and repost metadata."""

    calls = [dict(row) for row in rows if row.get("username")]
    by_mint: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    by_caller: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for row in calls:
        username = normalize_caller_username(str(row.get("username") or ""))
        mint = str(row.get("mint_address") or "").strip()
        called_at = row.get("called_at")
        if not mint or not isinstance(called_at, datetime):
            continue
        row["username"] = username
        row["called_at"] = _aware(called_at)
        by_caller[username].append(row)
        previous = by_mint[mint].get(username)
        if previous is None or row["called_at"] < previous["called_at"]:
            by_mint[mint][username] = row

    first_count: defaultdict[str, int] = defaultdict(int)
    top3_count: defaultdict[str, int] = defaultdict(int)
    lead_minutes: defaultdict[str, list[float]] = defaultdict(list)
    for caller_rows in by_mint.values():
        ordered = sorted(caller_rows.values(), key=lambda item: item["called_at"])
        for rank, row in enumerate(ordered, start=1):
            username = row["username"]
            if rank <= 3:
                top3_count[username] += 1
            if rank == 1:
                first_count[username] += 1
                if len(ordered) > 1:
                    delta = (
                        ordered[1]["called_at"] - row["called_at"]
                    ).total_seconds() / 60.0
                    if delta >= 0:
                        lead_minutes[username].append(delta)

    result: list[dict[str, Any]] = []
    for username, caller_rows in by_caller.items():
        unique_mints = {str(row.get("mint_address") or "") for row in caller_rows}
        evaluated = [row for row in caller_rows if row.get("outcome") not in {None, "pending"}]
        wins = sum(1 for row in evaluated if row.get("outcome") in {"win", "win_then_rug"})
        rugs = sum(1 for row in evaluated if row.get("outcome") in {"rug", "win_then_rug"})
        rois = [float(row["roi_multiple"]) for row in evaluated if row.get("roi_multiple") is not None]
        avg_roi = mean(rois) if rois else 0.0
        early = sum(
            1
            for row in caller_rows
            if row.get("call_market_cap_usd") is not None
            and float(row["call_market_cap_usd"]) <= 50_000
        )
        reposts = sum(1 for row in caller_rows if row.get("forwarded_from"))
        calls_count = len(caller_rows)
        mint_count = max(1, len(unique_mints))
        first_rate = first_count[username] / mint_count
        top3_rate = top3_count[username] / mint_count
        repost_rate = reposts / calls_count if calls_count else 0.0
        outcome_score = score_channel_metrics(
            calls=calls_count,
            evaluated=len(evaluated),
            wins=wins,
            rugs=rugs,
            early=early,
            avg_roi=avg_roi,
        )
        outcome_windows = _temporal_outcome_profile(caller_rows)
        temporal_outcome_score = _temporal_outcome_score(outcome_windows)
        originality_score = _clamp(
            (1.0 - repost_rate) * 55.0 + first_rate * 30.0 + top3_rate * 15.0
        )
        timing_score = _clamp(first_rate * 65.0 + top3_rate * 35.0)
        coordination_risk = _clamp(repost_rate * 80.0 + max(0.0, 0.3 - first_rate) * 30.0)
        experience_score = min(100.0, calls_count / 30.0 * 100.0)
        if temporal_outcome_score is None:
            reputation = _clamp(
                timing_score * 0.30
                + outcome_score * 0.30
                + originality_score * 0.25
                + experience_score * 0.15
            )
        else:
            reputation = _clamp(
                timing_score * 0.27
                + outcome_score * 0.18
                + temporal_outcome_score * 0.17
                + originality_score * 0.23
                + experience_score * 0.15
            )
        leads = lead_minutes.get(username, [])
        result.append(
            {
                "username": username,
                "calls": calls_count,
                "unique_mints": len(unique_mints),
                "evaluated": len(evaluated),
                "wins": wins,
                "win_rate": round(wins / len(evaluated), 4) if evaluated else 0.0,
                "rug_rate": round(rugs / len(evaluated), 4) if evaluated else 0.0,
                "avg_roi": round(float(avg_roi), 4),
                "early_calls": early,
                "first_calls": first_count[username],
                "top3_calls": top3_count[username],
                "reposts": reposts,
                "repost_rate": round(repost_rate, 4),
                "median_lead_minutes": round(median(leads), 2) if leads else None,
                "originality_score": round(originality_score, 1),
                "timing_score": round(timing_score, 1),
                "outcome_score": round(outcome_score, 1),
                "temporal_outcome_score": round(temporal_outcome_score, 1) if temporal_outcome_score is not None else None,
                "outcome_windows": outcome_windows,
                "coordination_risk": round(coordination_risk, 1),
                "reputation_score": round(reputation, 1),
            }
        )
    result.sort(key=lambda item: (item["reputation_score"], item["calls"]), reverse=True)
    return result


async def caller_reputation(
    session: AsyncSession,
    *,
    limit: int = 50,
) -> list[dict[str, Any]]:
    db_rows = (
        await session.execute(
            select(TelegramCall, TelegramMessage, TelegramChannel)
            .join(TelegramMessage, TelegramMessage.id == TelegramCall.message_id)
            .join(TelegramChannel, TelegramChannel.id == TelegramCall.channel_id)
            .where(TelegramCall.is_explicit_call.is_(True))
        )
    ).all()
    rows: list[dict[str, Any]] = []
    for call, message, channel in db_rows:
        raw = message.raw if isinstance(message.raw, dict) else {}
        username = normalize_caller_username(
            call.caller_username or channel.username or str(channel.telegram_id)
        )
        rows.append(
            {
                "username": username,
                "mint_address": call.mint_address,
                "called_at": call.called_at,
                "outcome": call.outcome,
                "roi_multiple": call.roi_multiple,
                "call_market_cap_usd": call.call_market_cap_usd,
                "forwarded_from": raw.get("forwarded_from"),
                "meta": call.meta or {},
            }
        )
    return build_caller_reputation(rows)[: max(1, min(int(limit), 250))]


async def token_coordination(
    session: AsyncSession,
    mint_address: str,
) -> dict[str, Any]:
    events = list(
        (
            await session.execute(
                select(SocialEvent)
                .where(
                    SocialEvent.platform == "telegram",
                    SocialEvent.mint_address == mint_address,
                )
                .order_by(SocialEvent.occurred_at.asc())
            )
        ).scalars().all()
    )
    return analyze_coordination_events(
        {
            "source_handle": event.source_handle,
            "text": event.text,
            "occurred_at": event.occurred_at,
            "payload": event.payload,
        }
        for event in events
    )


async def telegram_token_intelligence(
    session: AsyncSession,
    mint_address: str,
    *,
    caller_limit: int = 10,
) -> dict[str, Any]:
    coordination = await token_coordination(session, mint_address)
    calls = list(
        (
            await session.execute(
                select(TelegramCall, TelegramChannel)
                .join(TelegramChannel, TelegramChannel.id == TelegramCall.channel_id)
                .where(
                    TelegramCall.mint_address == mint_address,
                    TelegramCall.is_explicit_call.is_(True),
                )
                .order_by(TelegramCall.called_at.asc())
            )
        ).all()
    )
    relevant = {
        normalize_caller_username(call.caller_username or channel.username or str(channel.telegram_id))
        for call, channel in calls
    }
    all_reputation = await caller_reputation(session, limit=250)
    caller_rows = [row for row in all_reputation if row["username"] in relevant]
    caller_rows.sort(key=lambda item: item["reputation_score"], reverse=True)

    first_call = None
    if calls:
        call, channel = calls[0]
        first_call = {
            "source": normalize_caller_username(
                call.caller_username or channel.username or str(channel.telegram_id)
            ),
            "called_at": call.called_at,
            "call_market_cap_usd": call.call_market_cap_usd,
        }
    return {
        "coordination": coordination,
        "first_call": first_call,
        "callers": caller_rows[: max(1, min(int(caller_limit), 25))],
    }
