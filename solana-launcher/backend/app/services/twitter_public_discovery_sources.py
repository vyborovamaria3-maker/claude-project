from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

import httpx

from app.services.twitter_account_registry import normalize_twitter_username


@dataclass(slots=True)
class PublicHandle:
    username: str
    source_type: str
    source_ref: str
    source_url: str | None = None
    display_name: str | None = None
    account_type_hint: str = "unknown"
    relevance_hint: float = 35.0
    raw: dict[str, Any] | None = None


def _safe_username(value: str | None) -> str | None:
    try:
        return normalize_twitter_username(value)
    except ValueError:
        return None


def _handle_from_url(value: str | None) -> str | None:
    if not value:
        return None
    raw = value.strip()
    lowered = raw.lower()
    prefixes = (
        "https://x.com/",
        "http://x.com/",
        "https://www.x.com/",
        "http://www.x.com/",
        "https://twitter.com/",
        "http://twitter.com/",
        "https://www.twitter.com/",
        "http://www.twitter.com/",
    )
    marker = next((candidate for candidate in prefixes if lowered.startswith(candidate)), None)
    if marker is None:
        return None
    tail = raw[len(marker) :]
    handle = tail.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    normalized = _safe_username(handle)
    if not normalized or normalized in {
        "home",
        "explore",
        "search",
        "intent",
        "share",
        "i",
        "settings",
        "messages",
        "notifications",
    }:
        return None
    return normalized


def _dedupe(handles: Iterable[PublicHandle]) -> list[PublicHandle]:
    result: dict[str, PublicHandle] = {}
    for item in handles:
        key = _safe_username(item.username)
        if not key:
            continue
        current = result.get(key)
        if current is None or item.relevance_hint > current.relevance_hint:
            item.username = key
            result[key] = item
    return list(result.values())


def _validate_cmc_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("CoinMarketCap returned a non-object payload")
    status = payload.get("status")
    if isinstance(status, dict):
        error_code = status.get("error_code")
        if error_code is not None and str(error_code) != "0":
            message = str(status.get("error_message") or "unknown error")[:500]
            raise ValueError(f"CoinMarketCap error {error_code}: {message}")
    return payload


class DexScreenerDiscoverySource:
    def __init__(
        self,
        *,
        client: httpx.AsyncClient,
        base_url: str = "https://api.dexscreener.com",
    ) -> None:
        self.client = client
        self.base_url = base_url.rstrip("/")

    async def _json(self, path: str) -> Any:
        response = await self.client.get(f"{self.base_url}{path}")
        response.raise_for_status()
        return response.json()

    @staticmethod
    def _extract_links(
        record: dict[str, Any],
        *,
        source_type: str,
        source_ref: str,
    ) -> list[PublicHandle]:
        rows: list[PublicHandle] = []
        for link in record.get("links") or []:
            if not isinstance(link, dict):
                continue
            url = str(link.get("url") or "")
            handle = _handle_from_url(url)
            if handle:
                rows.append(
                    PublicHandle(
                        username=handle,
                        source_type=source_type,
                        source_ref=source_ref,
                        source_url=url,
                        account_type_hint="project",
                        relevance_hint=75.0,
                        raw=record,
                    )
                )
        info = record.get("info")
        if isinstance(info, dict):
            for social in info.get("socials") or []:
                if not isinstance(social, dict):
                    continue
                platform = str(social.get("platform") or "").lower()
                value = str(social.get("handle") or social.get("url") or "")
                handle = _handle_from_url(value) or (
                    _safe_username(value) if platform in {"twitter", "x"} else None
                )
                if handle:
                    rows.append(
                        PublicHandle(
                            username=handle,
                            source_type=source_type,
                            source_ref=source_ref,
                            source_url=value if value.startswith("http") else None,
                            account_type_hint="project",
                            relevance_hint=80.0,
                            raw=record,
                        )
                    )
        return rows

    async def latest_token_profiles(self) -> list[PublicHandle]:
        payload = await self._json("/token-profiles/latest/v1")
        records = payload if isinstance(payload, list) else [payload]
        handles: list[PublicHandle] = []
        for record in records:
            if (
                not isinstance(record, dict)
                or str(record.get("chainId") or "").lower() != "solana"
            ):
                continue
            ref = str(record.get("tokenAddress") or record.get("url") or "unknown")
            handles.extend(
                self._extract_links(
                    record,
                    source_type="dexscreener_profile",
                    source_ref=ref,
                )
            )
        return _dedupe(handles)

    async def latest_boosts(self) -> list[PublicHandle]:
        payload = await self._json("/token-boosts/latest/v1")
        records = payload if isinstance(payload, list) else [payload]
        handles: list[PublicHandle] = []
        for record in records:
            if (
                not isinstance(record, dict)
                or str(record.get("chainId") or "").lower() != "solana"
            ):
                continue
            ref = str(record.get("tokenAddress") or record.get("url") or "unknown")
            handles.extend(
                self._extract_links(
                    record,
                    source_type="dexscreener_boost",
                    source_ref=ref,
                )
            )
        return _dedupe(handles)

    async def token_socials(self, token_addresses: list[str]) -> list[PublicHandle]:
        addresses = [value.strip() for value in token_addresses if value and value.strip()][:30]
        if not addresses:
            return []
        payload = await self._json(f"/tokens/v1/solana/{','.join(addresses)}")
        records = payload if isinstance(payload, list) else []
        handles: list[PublicHandle] = []
        for record in records:
            if not isinstance(record, dict):
                continue
            base = record.get("baseToken") if isinstance(record.get("baseToken"), dict) else {}
            ref = str(base.get("address") or record.get("pairAddress") or "unknown")
            handles.extend(
                self._extract_links(
                    record,
                    source_type="dexscreener_token",
                    source_ref=ref,
                )
            )
        return _dedupe(handles)


class CoinMarketCapKeylessDiscoverySource:
    def __init__(
        self,
        *,
        client: httpx.AsyncClient,
        base_url: str = "https://pro-api.coinmarketcap.com/public-api",
    ) -> None:
        self.client = client
        self.base_url = base_url.rstrip("/")

    async def discover(self, *, start: int = 1, limit: int = 500) -> list[PublicHandle]:
        listings = await self.client.get(
            f"{self.base_url}/v3/cryptocurrency/listings/latest",
            params={"start": max(1, int(start)), "limit": max(1, min(int(limit), 5000))},
            headers={"Accept": "application/json"},
        )
        listings.raise_for_status()
        body = _validate_cmc_payload(listings.json())
        rows = body.get("data")
        if not isinstance(rows, list):
            return []

        ids: list[str] = []
        for row in rows:
            if isinstance(row, dict) and row.get("id") is not None:
                ids.append(str(row["id"]))
        if not ids:
            return []

        handles: list[PublicHandle] = []
        for offset in range(0, len(ids), 100):
            batch = ids[offset : offset + 100]
            response = await self.client.get(
                f"{self.base_url}/v2/cryptocurrency/info",
                params={"id": ",".join(batch)},
                headers={"Accept": "application/json"},
            )
            response.raise_for_status()
            payload = _validate_cmc_payload(response.json())
            data = payload.get("data")
            if not isinstance(data, dict):
                continue
            for cmc_id, record in data.items():
                if not isinstance(record, dict):
                    continue
                urls = record.get("urls") if isinstance(record.get("urls"), dict) else {}
                for url in urls.get("twitter") or []:
                    handle = _handle_from_url(str(url))
                    if handle:
                        handles.append(
                            PublicHandle(
                                username=handle,
                                source_type="coinmarketcap_keyless",
                                source_ref=str(cmc_id),
                                source_url=str(url),
                                account_type_hint="project",
                                relevance_hint=65.0,
                                raw={
                                    "id": cmc_id,
                                    "name": record.get("name"),
                                    "symbol": record.get("symbol"),
                                },
                            )
                        )
        return _dedupe(handles)
