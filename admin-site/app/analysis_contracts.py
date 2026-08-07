from __future__ import annotations

from typing import Any

from .analysis_catalog import CATALOG_BY_ID, DOMAINS, catalog_for

DERIVED_TELEGRAM_KEYS = {"confidence", "early_rate", "roi_component"}
TELEGRAM_CHANNEL_KEYS = {"participants", "calls_count", "win_rate", "rug_rate", "avg_roi", "channel_score"}
TELEGRAM_SCORE_RECORD_KEYS = {"evaluated_calls", "successful_calls", "rug_calls", "early_calls"}
TELEGRAM_CALL_KEYS = {"explicit_call", "call_market_cap", "peak_market_cap", "roi_multiple", "outcome"}
TELEGRAM_MESSAGE_KEYS = {"message_views", "message_forwards", "message_replies", "message_reactions"}


def _contract_for(row: dict[str, Any]) -> str:
    domain = row["domain"]
    key = row["key"]
    ref = row.get("project_ref", "")
    if domain == "wallet":
        if "dev-wallet" in ref:
            return "wallet.dev_wallet"
        if "dev-forensics" in ref:
            return "wallet.forensics"
        if "backend/" in ref:
            return "wallet.analytics"
        return "wallet.creator_summary"
    if domain == "token":
        if "dev-forensics" in ref:
            return "token.forensics"
        if "backend/" in ref:
            return "token.analytics"
        return "token.creator_token"
    if domain == "telegram":
        if key in DERIVED_TELEGRAM_KEYS:
            return "telegram.derived"
        if key in TELEGRAM_CHANNEL_KEYS:
            return "telegram.channel"
        if key in TELEGRAM_SCORE_RECORD_KEYS:
            return "telegram.score_record"
        if key in TELEGRAM_CALL_KEYS:
            return "telegram.call"
        if key in TELEGRAM_MESSAGE_KEYS:
            return "telegram.message"
        if key == "timeline_mentions":
            return "telegram.timeline"
        return "telegram.misc"
    if domain == "x":
        return "x.legacy" if row.get("runtime_state") == "legacy" else "x.dev_twitter"
    return f"{domain}.unknown"


def enrich_row(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    if out["domain"] == "token" and out["key"] == "social_engagements":
        out["type"] = "object"
    if out["domain"] == "telegram" and out["key"] in DERIVED_TELEGRAM_KEYS:
        out["runtime_state"] = "derived"
    if out["domain"] == "telegram" and out["key"] == "explicit_call":
        out["source"] = "explicit_call"
    out["contract"] = _contract_for(out)
    out["rule_capable"] = out["type"] != "object" and out["runtime_state"] != "legacy"
    out["rule_active"] = bool(out.get("enabled") and out.get("threshold") and out["rule_capable"])
    return out


def enriched_catalog_for(domain: str | None = None) -> list[dict[str, Any]]:
    if domain is not None and domain not in DOMAINS:
        raise ValueError("Unknown analysis domain")
    return [enrich_row(row) for row in catalog_for(domain)]


def enriched_builtin(domain: str, key: str) -> dict[str, Any] | None:
    row = CATALOG_BY_ID.get((domain, key))
    return enrich_row(row) if row is not None else None
