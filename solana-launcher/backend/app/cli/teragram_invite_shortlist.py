from __future__ import annotations

import argparse
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

_SOLANA_HINT_RE = re.compile(
    r"(?<![A-Za-z0-9_])(?:solana|[$]sol|pump[.]fun|pumpfun|raydium|solscan|spl\s*token)(?![A-Za-z0-9_])",
    re.IGNORECASE,
)
_MEME_HINT_RE = re.compile(
    r"(?<![A-Za-z0-9_])(?:memecoins?|meme\s*coins?|meme\s*tokens?|bonk|dogwifhat|[$]wif|pepe|degen|shitcoin)(?![A-Za-z0-9_])",
    re.IGNORECASE,
)
_CALL_HINT_RE = re.compile(
    r"(?<![A-Za-z0-9_])(?:calls?|caller|alpha|gem|entry|100x|50x|20x|10x|ca|contract|launch|mcap)(?![A-Za-z0-9_])",
    re.IGNORECASE,
)
_NEGATIVE_RE = re.compile(
    r"(?:no\s+crypto|no\s+ads|not\s+financial\s+advi[cs]e|impersonates|scam|fake)",
    re.IGNORECASE,
)
_ALLOWED_CLASSES = {
    "crypto",
    "solana",
    "memecoin",
    "caller",
    "memecoin_calls",
    "solana_memecoin",
}


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.is_file():
        return rows
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                rows.append(item)
    return rows


def _read_discovery(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    candidates = payload.get("candidates") if isinstance(payload, dict) else None
    return (
        [row for row in candidates if isinstance(row, dict)] if isinstance(candidates, list) else []
    )


def _safe_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _safe_float(value: Any) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _classes(row: dict[str, Any]) -> set[str]:
    return {
        str(value).strip().lower()
        for value in (row.get("classifications") or [])
        if str(value).strip().lower() in _ALLOWED_CLASSES
    }


def _signals(row: dict[str, Any]) -> dict[str, Any]:
    raw = row.get("signals")
    return raw if isinstance(raw, dict) else {}


def _text(row: dict[str, Any]) -> str:
    return "\n".join(str(row.get(name) or "") for name in ("username", "title", "description"))


def _score_root(row: dict[str, Any]) -> tuple[float, list[str], list[str]]:
    signals = _signals(row)
    classes = _classes(row)
    text = _text(row)
    reasons: list[str] = []
    cautions: list[str] = []

    target_messages = _safe_int(signals.get("target_messages"))
    solana_messages = _safe_int(signals.get("solana_messages"))
    memecoin_messages = _safe_int(signals.get("memecoin_messages"))
    target_days = _safe_int(signals.get("target_days"))
    native_messages = _safe_int(signals.get("native_messages"))
    native_days = _safe_int(signals.get("native_days"))
    density = _safe_float(signals.get("target_density"))
    subscribers = _safe_int(row.get("n_subscribers"))

    score = 0.0
    path = str(row.get("nomination_path") or "")
    if path == "native":
        score += 25.0
        reasons.append("native_solana_evidence")
    elif path == "repeated":
        score += 18.0
        reasons.append("repeated_target_evidence")

    if "solana_memecoin" in classes:
        score += 20.0
        reasons.append("solana_memecoin_overlap")
    elif "memecoin" in classes:
        score += 12.0
        reasons.append("memecoin_class")
    elif "solana" in classes:
        score += 10.0
        reasons.append("solana_class")

    if target_messages >= 10:
        score += 12.0
        reasons.append("many_target_messages")
    elif target_messages >= 4:
        score += 8.0
        reasons.append("several_target_messages")
    elif target_messages >= 2:
        score += 4.0

    if target_days >= 7:
        score += 10.0
        reasons.append("multi_day_target_history")
    elif target_days >= 2:
        score += 5.0

    if native_messages >= 2 and native_days >= 2:
        score += 12.0
    if solana_messages > 0 and memecoin_messages > 0:
        score += 10.0
    if density >= 0.005:
        score += 10.0
        reasons.append("high_target_density")
    elif density >= 0.001:
        score += 5.0

    if subscribers >= 100_000:
        score += 8.0
    elif subscribers >= 10_000:
        score += 5.0
    elif subscribers >= 1_000:
        score += 2.0

    if row.get("username"):
        score += 10.0
        reasons.append("has_public_username")
    else:
        score -= 30.0
        cautions.append("missing_username")

    if _SOLANA_HINT_RE.search(text):
        score += 5.0
    if _MEME_HINT_RE.search(text):
        score += 5.0
    if _CALL_HINT_RE.search(text):
        score += 4.0
    if _NEGATIVE_RE.search(text):
        score -= 18.0
        cautions.append("negative_metadata_hint")

    if row.get("scam"):
        score -= 50.0
        cautions.append("scam_flag")

    return round(max(0.0, min(100.0, score)), 1), reasons, cautions


def _score_discovery(row: dict[str, Any]) -> tuple[float, list[str], list[str]]:
    raw_flags = row.get("flags")
    flags = cast(dict[str, Any], raw_flags) if isinstance(raw_flags, dict) else {}
    raw_evidence = row.get("evidence")
    evidence = cast(dict[str, Any], raw_evidence) if isinstance(raw_evidence, dict) else {}
    text = _text(row)
    reasons = [str(value) for value in (row.get("reasons") or [])]
    cautions: list[str] = []

    score = min(45.0, _safe_float(row.get("historical_discovery_score")) * 0.55)
    connected = _safe_int(evidence.get("connected_root_count"))
    forwards = _safe_int(evidence.get("forward_count"))
    refs = _safe_int(evidence.get("telegram_reference_count"))
    overlap = _safe_int(evidence.get("audience_overlap"))
    subscribers = _safe_int(row.get("members_count"))

    if connected >= 10:
        score += 12.0
    elif connected >= 2:
        score += 6.0
    if overlap >= 5:
        score += 10.0
    elif overlap >= 2:
        score += 5.0
    if forwards >= 50 or refs >= 50:
        score += 7.0
    if subscribers >= 100_000:
        score += 7.0
    elif subscribers >= 10_000:
        score += 4.0

    if row.get("username"):
        score += 8.0
    else:
        score -= 30.0
        cautions.append("missing_username")

    if _SOLANA_HINT_RE.search(text) or _MEME_HINT_RE.search(text):
        score += 8.0
        reasons.append("target_metadata_hint")
    else:
        cautions.append("graph_only_needs_live_relevance_check")

    if _NEGATIVE_RE.search(text):
        score -= 25.0
        cautions.append("negative_metadata_hint")
    if flags.get("scam") or flags.get("fake"):
        score -= 60.0
        cautions.append("unsafe_flag")
    if flags.get("restricted"):
        score -= 15.0
        cautions.append("restricted_flag")

    return round(max(0.0, min(100.0, score)), 1), reasons, cautions


def _tier(score: float, cautions: list[str], source: str) -> str:
    if "missing_username" in cautions:
        return "needs_manual_resolution"
    if source == "graph" and "graph_only_needs_live_relevance_check" in cautions and score < 55:
        return "watchlist"
    if score >= 70:
        return "priority_live_validation"
    if score >= 50:
        return "secondary_live_validation"
    if score >= 30:
        return "watchlist"
    return "reject_offline"


def build_shortlist(
    *,
    nominations_path: Path,
    discovery_path: Path,
    output_dir: Path,
    limit: int,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    merged: dict[str, dict[str, Any]] = {}

    for row in _read_jsonl(nominations_path):
        username = str(row.get("username") or "").strip().lstrip("@")
        key = username.lower() if username else f"id:{row.get('teragram_chat_id')}"
        score, reasons, cautions = _score_root(row)
        item = {
            "username": username,
            "title": row.get("title", ""),
            "description": row.get("description", ""),
            "source": "nomination",
            "teragram_chat_id": str(row.get("teragram_chat_id") or ""),
            "channel_id": str(row.get("channel_id") or ""),
            "n_subscribers": _safe_int(row.get("n_subscribers")),
            "historical_score": score,
            "nomination_path": row.get("nomination_path"),
            "classifications": sorted(_classes(row)),
            "signals": _signals(row),
            "reasons": sorted(set(reasons)),
            "cautions": sorted(set(cautions)),
        }
        item["tier"] = _tier(score, item["cautions"], item["source"])
        merged[key] = item

    for row in _read_discovery(discovery_path):
        username = str(row.get("username") or "").strip().lstrip("@")
        key = username.lower() if username else f"id:{row.get('teragram_chat_id')}"
        score, reasons, cautions = _score_discovery(row)
        item = {
            "username": username,
            "title": row.get("title", ""),
            "description": row.get("description", ""),
            "source": "graph",
            "teragram_chat_id": str(row.get("teragram_chat_id") or ""),
            "channel_id": str(row.get("telegram_id") or ""),
            "n_subscribers": _safe_int(row.get("members_count")),
            "historical_score": score,
            "historical_discovery_score": _safe_float(row.get("historical_discovery_score")),
            "graph_evidence": row.get("evidence") if isinstance(row.get("evidence"), dict) else {},
            "reasons": sorted(set(reasons)),
            "cautions": sorted(set(cautions)),
        }
        item["tier"] = _tier(score, item["cautions"], item["source"])

        previous = merged.get(key)
        if previous is None or item["historical_score"] > previous["historical_score"]:
            merged[key] = item

    rows = sorted(
        merged.values(),
        key=lambda row: (
            row["tier"] == "priority_live_validation",
            row["tier"] == "secondary_live_validation",
            row["historical_score"],
            row["n_subscribers"],
        ),
        reverse=True,
    )
    selected = rows[:limit]
    accepted = [
        row
        for row in selected
        if row["tier"] in {"priority_live_validation", "secondary_live_validation"}
        and row.get("username")
    ]

    tiers: dict[str, int] = {}
    for row in rows:
        tiers[row["tier"]] = tiers.get(row["tier"], 0) + 1

    shortlist_path = output_dir / "invite_shortlist.json"
    usernames_path = output_dir / "invite_shortlist_usernames.txt"
    seed_path = output_dir / "telegram_seed_database.json"
    summary_path = output_dir / "summary.json"

    payload = {
        "generated_at": _now(),
        "source": "teragram_invite_shortlist",
        "nominations_path": str(nominations_path),
        "discovery_path": str(discovery_path),
        "total_ranked": len(rows),
        "selected": len(selected),
        "accepted_for_live_validation": len(accepted),
        "tiers": tiers,
        "note": (
            "Offline shortlist only. Run live MTProto validation before parsing users or inviting."
        ),
        "channels": selected,
    }
    shortlist_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    usernames_path.write_text(
        "\n".join(row["username"] for row in accepted) + ("\n" if accepted else ""),
        encoding="utf-8",
    )

    seed_document = {
        "generated_at": payload["generated_at"],
        "source": "teragram_invite_shortlist",
        "channels": [
            {
                "username": row["username"],
                "seed_score": row["historical_score"],
                "scores": {"invite_shortlist": row["historical_score"]},
                "classifications": row.get("classifications") or ["crypto"],
                "n_subscribers": row["n_subscribers"],
                "channel_id": row["channel_id"],
                "teragram_chat_id": row["teragram_chat_id"],
                "requires_live_validation": True,
                "shortlist_tier": row["tier"],
                "source": row["source"],
            }
            for row in accepted
        ],
    }
    seed_path.write_text(json.dumps(seed_document, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = {
        "generated_at": payload["generated_at"],
        "signal_source": "historical_nomination_plus_graph",
        "chats_total": 7000,
        "prefiltered_chats": len(rows),
        "candidate_channels": len(selected),
        "seed_channels": len(accepted),
        "signal_rows_exactly_scored": 0,
        "categories": {
            "priority_live_validation": tiers.get("priority_live_validation", 0),
            "secondary_live_validation": tiers.get("secondary_live_validation", 0),
            "watchlist": tiers.get("watchlist", 0),
        },
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Rank TeraGram historical candidates for parsing and inviting."
    )
    parser.add_argument("--nominations", required=True)
    parser.add_argument("--discovery", required=True)
    parser.add_argument(
        "--output",
        default="data/teragram_historical_temporal_test/invite_shortlist",
    )
    parser.add_argument("--limit", type=int, default=250)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be positive")
    payload = build_shortlist(
        nominations_path=Path(args.nominations),
        discovery_path=Path(args.discovery),
        output_dir=Path(args.output),
        limit=args.limit,
    )
    print(
        json.dumps(
            {
                "total_ranked": payload["total_ranked"],
                "selected": payload["selected"],
                "accepted_for_live_validation": payload["accepted_for_live_validation"],
                "tiers": payload["tiers"],
                "output": args.output,
            },
            ensure_ascii=False,
            indent=2,
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
