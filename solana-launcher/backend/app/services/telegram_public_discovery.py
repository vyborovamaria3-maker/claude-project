from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import re
from typing import Any, Iterable

from app.services.social_intelligence import upsert_channel_score
from app.services.telegram_parser import normalize_telegram_target, parse_telegram_message
from app.services.telegram_public_web import (
    PublicTelegramMessage,
    TelegramPublicWebCollector,
    TelegramPublicWebError,
    TelegramPublicWebUnavailable,
    utcnow,
)


_TME_CHANNEL_RE = re.compile(
    r"https?://(?:www\.)?t\.me/(?:s/)?([A-Za-z0-9_]{4,64})(?=$|[/?#])",
    re.IGNORECASE,
)
_MEMECOIN_KEYWORDS_RE = re.compile(
    r"\b(?:memecoin|meme\s*coin|solana|pumpfun|pump\.fun|raydium|dexscreener|birdeye|"
    r"market\s*cap|mcap|bonding|cto|gem|entry|ape|launch|caller|call)\b",
    re.IGNORECASE,
)
_RESERVED_TME_TARGETS = {
    "addstickers",
    "confirmphone",
    "contact",
    "iv",
    "joinchat",
    "login",
    "proxy",
    "setlanguage",
    "share",
    "socks",
}


def _message_evidence(message: PublicTelegramMessage) -> str:
    parts = [message.text, *message.links]
    return "\n".join(part.strip() for part in parts if part and part.strip())


def extract_discovered_channels(
    messages: Iterable[PublicTelegramMessage],
    *,
    source_username: str | None = None,
) -> list[str]:
    """Return only channels referenced by explicit t.me links.

    Plain @mentions are intentionally ignored so graph expansion stays evidence-based and bounded.
    """

    source = normalize_telegram_target(source_username or "")
    result: list[str] = []
    for message in messages:
        evidence_parts = [message.text, *message.links]
        for evidence in evidence_parts:
            for match in _TME_CHANNEL_RE.finditer(evidence or ""):
                candidate = normalize_telegram_target(match.group(1))
                if not candidate or candidate == source or candidate in _RESERVED_TME_TARGETS:
                    continue
                if candidate not in result:
                    result.append(candidate)
    return result


@dataclass(frozen=True, slots=True)
class TelegramChannelRelevance:
    score: float
    posts_analyzed: int
    token_posts: int
    explicit_call_posts: int
    unique_mints: int
    pumpfun_posts: int
    keyword_posts: int
    linked_channels: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "score": self.score,
            "posts_analyzed": self.posts_analyzed,
            "token_posts": self.token_posts,
            "explicit_call_posts": self.explicit_call_posts,
            "unique_mints": self.unique_mints,
            "pumpfun_posts": self.pumpfun_posts,
            "keyword_posts": self.keyword_posts,
            "linked_channels": self.linked_channels,
        }


def score_memecoin_channel(messages: Iterable[PublicTelegramMessage]) -> TelegramChannelRelevance:
    rows = list(messages)
    token_posts = 0
    explicit_call_posts = 0
    pumpfun_posts = 0
    keyword_posts = 0
    unique_mints: set[str] = set()

    for message in rows:
        evidence = _message_evidence(message)
        parsed = parse_telegram_message(evidence)
        if parsed.addresses:
            token_posts += 1
            unique_mints.update(parsed.addresses)
        if parsed.explicit_call:
            explicit_call_posts += 1
        lowered = evidence.lower()
        if "pump.fun" in lowered or any(address.lower().endswith("pump") for address in parsed.addresses):
            pumpfun_posts += 1
        if _MEMECOIN_KEYWORDS_RE.search(evidence):
            keyword_posts += 1

    posts_analyzed = len(rows)
    token_density = token_posts / posts_analyzed if posts_analyzed else 0.0
    score = (
        min(35.0, token_posts * 8.0)
        + min(20.0, explicit_call_posts * 6.0)
        + min(20.0, len(unique_mints) * 5.0)
        + min(10.0, pumpfun_posts * 4.0)
        + min(10.0, keyword_posts * 1.5)
        + min(5.0, token_density * 20.0)
    )
    # Crypto/news channels with keywords but no actual Solana mint evidence should never qualify.
    if token_posts == 0:
        score = min(score, 20.0)

    return TelegramChannelRelevance(
        score=round(min(100.0, score), 1),
        posts_analyzed=posts_analyzed,
        token_posts=token_posts,
        explicit_call_posts=explicit_call_posts,
        unique_mints=len(unique_mints),
        pumpfun_posts=pumpfun_posts,
        keyword_posts=keyword_posts,
        linked_channels=len(extract_discovered_channels(rows)),
    )


@dataclass(frozen=True, slots=True)
class _QueueItem:
    username: str
    depth: int
    discovered_from: str | None
    is_seed: bool


class TelegramPublicWebDiscoveryCollector(TelegramPublicWebCollector):
    """Public Telegram collector with bounded graph discovery and relevance filtering."""

    def __init__(self, settings, sessionmaker) -> None:
        super().__init__(settings, sessionmaker)
        self._last_discovered_channels = 0
        self._last_accepted_discovered = 0
        self._last_rejected_discovered = 0

    @property
    def discovery_enabled(self) -> bool:
        return bool(getattr(self.settings, "telegram_public_web_discovery_enabled", True))

    @property
    def discovery_depth(self) -> int:
        return max(0, min(int(getattr(self.settings, "telegram_public_web_discovery_depth", 2)), 3))

    @property
    def discovery_entity_limit(self) -> int:
        return max(1, min(int(getattr(self.settings, "telegram_public_web_discovery_entity_limit", 25)), 500))

    @property
    def relevance_min_score(self) -> float:
        return max(0.0, min(float(getattr(self.settings, "telegram_public_web_relevance_min_score", 35.0)), 100.0))

    @property
    def discovery_history_limit(self) -> int:
        return max(10, min(int(getattr(self.settings, "telegram_public_web_discovery_history_limit", 40)), 200))

    def status(self) -> dict[str, Any]:
        payload = super().status()
        payload.update(
            {
                "discovery_enabled": self.discovery_enabled,
                "discovery_depth": self.discovery_depth,
                "discovery_entity_limit": self.discovery_entity_limit,
                "relevance_min_score": self.relevance_min_score,
                "last_discovered_channels": self._last_discovered_channels,
                "last_accepted_discovered": self._last_accepted_discovered,
                "last_rejected_discovered": self._last_rejected_discovered,
            }
        )
        return payload

    async def _persist_loaded_channel(
        self,
        username: str,
        messages: list[PublicTelegramMessage],
        *,
        relevance: TelegramChannelRelevance,
        discovered_from: str | None,
        discovery_depth: int,
    ) -> dict[str, Any]:
        saved = matches = 0
        async with self.sessionmaker() as session:
            channel = await self._upsert_channel(session, username)
            channel.meta = {
                **(channel.meta or {}),
                "memecoin_relevance": relevance.as_dict(),
                "discovered_from": discovered_from,
                "discovery_depth": discovery_depth,
            }
            for message in reversed(messages):
                if message.published_at is None:
                    continue
                matches += await self._save_message(session, channel, message)
                saved += 1
            if saved == 0:
                raise TelegramPublicWebUnavailable("Telegram public preview had no timestamped messages")
            if matches:
                await upsert_channel_score(session, channel.id)
            channel.last_scanned_at = utcnow()
            await session.commit()
        return {
            "platform": "telegram",
            "collector": "public_web",
            "username": username,
            "posts_saved": saved,
            "token_mentions_created": matches,
            "memecoin_relevance": relevance.as_dict(),
            "discovered_from": discovered_from,
            "discovery_depth": discovery_depth,
        }

    async def scan_channels(
        self,
        channels: list[str] | None = None,
        *,
        history_limit: int | None = None,
    ) -> dict[str, Any]:
        if not self.settings.telegram_public_web_enabled:
            raise TelegramPublicWebUnavailable("TG_PUBLIC_WEB_ENABLED is false")

        seeds: list[str] = []
        for item in channels or self.configured_channels:
            normalized = normalize_telegram_target(item)
            if normalized and normalized not in seeds:
                seeds.append(normalized)
        if not seeds:
            raise TelegramPublicWebUnavailable("No public Telegram channels are configured")

        if not self.discovery_enabled:
            self._last_discovered_channels = 0
            self._last_accepted_discovered = 0
            self._last_rejected_discovered = 0
            return await super().scan_channels(seeds, history_limit=history_limit)

        seed_history_limit = max(
            1,
            min(int(history_limit or self.settings.telegram_public_web_history_limit), 500),
        )
        candidate_history_limit = min(seed_history_limit, self.discovery_history_limit)
        max_entities = max(len(seeds), self.discovery_entity_limit)
        queue = deque(_QueueItem(seed, 0, None, True) for seed in seeds)
        scheduled = set(seeds)
        results: list[dict[str, Any]] = []
        accepted_channels: list[str] = []
        discovered_total = accepted_discovered = rejected_discovered = 0

        self._running = True
        self._channels = list(seeds)
        self._last_error = None
        self._last_scan_at = None
        try:
            while queue:
                item = queue.popleft()
                limit = seed_history_limit if item.is_seed else candidate_history_limit
                try:
                    messages = await self._load_channel(item.username, limit)
                    relevance = score_memecoin_channel(messages)
                    accepted = item.is_seed or (
                        relevance.token_posts > 0 and relevance.score >= self.relevance_min_score
                    )

                    if not accepted:
                        rejected_discovered += 1
                        results.append(
                            {
                                "username": item.username,
                                "collector": "public_web",
                                "filtered": True,
                                "reason": "memecoin_relevance_below_threshold",
                                "memecoin_relevance": relevance.as_dict(),
                                "discovered_from": item.discovered_from,
                                "discovery_depth": item.depth,
                            }
                        )
                        continue

                    persisted = await self._persist_loaded_channel(
                        item.username,
                        messages,
                        relevance=relevance,
                        discovered_from=item.discovered_from,
                        discovery_depth=item.depth,
                    )
                    results.append(persisted)
                    if item.username not in accepted_channels:
                        accepted_channels.append(item.username)
                    if not item.is_seed:
                        accepted_discovered += 1

                    if item.depth >= self.discovery_depth:
                        continue
                    for candidate in extract_discovered_channels(messages, source_username=item.username):
                        if candidate in scheduled or len(scheduled) >= max_entities:
                            continue
                        scheduled.add(candidate)
                        discovered_total += 1
                        queue.append(
                            _QueueItem(
                                username=candidate,
                                depth=item.depth + 1,
                                discovered_from=item.username,
                                is_seed=False,
                            )
                        )
                except TelegramPublicWebError as exc:
                    results.append(
                        {
                            "username": item.username,
                            "collector": "public_web",
                            "error": str(exc),
                            "discovered_from": item.discovered_from,
                            "discovery_depth": item.depth,
                        }
                    )

            successful = [row for row in results if not row.get("error") and not row.get("filtered")]
            errors = [str(row.get("error")) for row in results if row.get("error")]
            self._last_scan_messages = sum(int(row.get("posts_saved") or 0) for row in successful)
            self._last_scan_matches = sum(int(row.get("token_mentions_created") or 0) for row in successful)
            self._last_error = errors[0] if errors and not successful else None
            self._last_scan_at = utcnow() if successful else None
            self._last_discovered_channels = discovered_total
            self._last_accepted_discovered = accepted_discovered
            self._last_rejected_discovered = rejected_discovered
            self._channels = accepted_channels or list(seeds)

            return {
                "collector": "public_web",
                "processed": len(results),
                "successful": len(successful),
                "posts_saved": self._last_scan_messages,
                "token_mentions_created": self._last_scan_matches,
                "discovery": {
                    "enabled": True,
                    "max_depth": self.discovery_depth,
                    "entity_limit": self.discovery_entity_limit,
                    "relevance_min_score": self.relevance_min_score,
                    "discovered": discovered_total,
                    "accepted": accepted_discovered,
                    "rejected": rejected_discovered,
                },
                "results": results,
            }
        finally:
            self._running = False
