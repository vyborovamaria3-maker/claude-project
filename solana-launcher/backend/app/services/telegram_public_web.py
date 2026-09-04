from __future__ import annotations

import asyncio
import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.models.social_intelligence import (
    SocialEvent,
    TelegramCall,
    TelegramChannel,
    TelegramMessage,
    TelegramTokenMention,
)
from app.services.social_intelligence import nearest_token_snapshot, upsert_channel_score
from app.services.social_relations import upsert_social_relation
from app.services.telegram_parser import normalize_telegram_target, parse_telegram_message


_METRIC_RE = re.compile(r"^\s*([0-9]+(?:[.,][0-9]+)?)\s*([KMB])?\s*$", re.I)
_MAX_RESPONSE_BYTES = 3 * 1024 * 1024
_MAX_PAGES_PER_CHANNEL = 20
_REQUEST_INTERVAL_SECONDS = 0.35
_RETRY_DELAYS_SECONDS = (0.6, 1.5)
_VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151 Safari/537.36"
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def parse_metric_count(value: str | None) -> int | None:
    if not value:
        return None
    match = _METRIC_RE.match(value)
    if not match:
        return None
    number = float(match.group(1).replace(",", "."))
    suffix = (match.group(2) or "").upper()
    multiplier = {"": 1, "K": 1_000, "M": 1_000_000, "B": 1_000_000_000}[suffix]
    return max(0, int(round(number * multiplier)))


def _public_channel_id(username: str) -> int:
    # Telegram channel IDs are positive. A stable negative ID lets public-web rows live in
    # the same schema until MTProto later resolves the real ID; the MTProto upsert merges it.
    digest = hashlib.sha256(f"telegram-public:{username.lower()}".encode("utf-8")).digest()
    value = int.from_bytes(digest[:8], "big") & ((1 << 63) - 1)
    return -(value or 1)


def _clean_text(parts: list[str]) -> str:
    text = "".join(parts)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    return text.strip()


def _message_evidence(message: "PublicTelegramMessage") -> str:
    parts = [message.text, *message.links]
    return "\n".join(part.strip() for part in parts if part and part.strip())


@dataclass(slots=True)
class PublicTelegramMessage:
    channel_username: str
    message_id: int
    url: str
    published_at: datetime | None = None
    text: str = ""
    views: int | None = None
    forwarded_from: str | None = None
    reply_url: str | None = None
    links: list[str] = field(default_factory=list)


class TelegramPublicPageParser(HTMLParser):
    """Parse Telegram's public widget markup without browser automation or regexing HTML."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.messages: list[PublicTelegramMessage] = []
        self._depth = 0
        self._message_depth: int | None = None
        self._text_depth: int | None = None
        self._views_depth: int | None = None
        self._forward_depth: int | None = None
        self._current: PublicTelegramMessage | None = None
        self._text_parts: list[str] = []
        self._views_parts: list[str] = []
        self._forward_parts: list[str] = []

    @staticmethod
    def _attrs(attrs: list[tuple[str, str | None]]) -> dict[str, str]:
        return {key: value or "" for key, value in attrs}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        is_void = tag in _VOID_TAGS
        if not is_void:
            self._depth += 1
        values = self._attrs(attrs)
        classes = set(values.get("class", "").split())
        data_post = values.get("data-post", "").strip()

        if self._current is None and data_post and "tgme_widget_message" in classes:
            channel, separator, raw_id = data_post.rpartition("/")
            username = normalize_telegram_target(channel)
            try:
                message_id = int(raw_id) if separator else 0
            except ValueError:
                message_id = 0
            if username and message_id > 0:
                self._current = PublicTelegramMessage(
                    channel_username=username,
                    message_id=message_id,
                    url=f"https://t.me/{username}/{message_id}",
                )
                self._message_depth = self._depth
                self._text_parts = []
                self._views_parts = []
                self._forward_parts = []

        current = self._current
        if current is None:
            return

        href = values.get("href", "").strip()
        if href and tag == "a":
            if href.startswith("https://t.me/") or href.startswith("http://t.me/"):
                href = "https://" + href.split("://", 1)[1]
            if href not in current.links:
                current.links.append(href)
            if "tgme_widget_message_reply" in classes:
                current.reply_url = href

        if "tgme_widget_message_text" in classes:
            self._text_depth = self._depth
        if "tgme_widget_message_views" in classes:
            self._views_depth = self._depth
        if "tgme_widget_message_forwarded_from_name" in classes:
            self._forward_depth = self._depth

        if tag == "time":
            published_at = _parse_datetime(values.get("datetime"))
            if published_at is not None:
                current.published_at = published_at

        if tag == "br" and self._text_depth is not None:
            self._text_parts.append("\n")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in _VOID_TAGS:
            self.handle_endtag(tag)

    def handle_data(self, data: str) -> None:
        if self._current is None:
            return
        if self._text_depth is not None:
            self._text_parts.append(data)
        if self._views_depth is not None:
            self._views_parts.append(data)
        if self._forward_depth is not None:
            self._forward_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in _VOID_TAGS:
            return
        if self._current is not None:
            if self._text_depth == self._depth:
                self._text_depth = None
            if self._views_depth == self._depth:
                self._views_depth = None
            if self._forward_depth == self._depth:
                self._forward_depth = None
            if self._message_depth == self._depth:
                self._current.text = _clean_text(self._text_parts)
                self._current.views = parse_metric_count(_clean_text(self._views_parts))
                forwarded = _clean_text(self._forward_parts)
                self._current.forwarded_from = forwarded or None
                self.messages.append(self._current)
                self._current = None
                self._message_depth = None
                self._text_depth = None
                self._views_depth = None
                self._forward_depth = None
        self._depth = max(0, self._depth - 1)


def parse_public_telegram_html(html: str) -> list[PublicTelegramMessage]:
    parser = TelegramPublicPageParser()
    parser.feed(html or "")
    parser.close()
    return parser.messages


class TelegramPublicWebError(RuntimeError):
    pass


class TelegramPublicWebUnavailable(TelegramPublicWebError):
    pass


class TelegramPublicWebCollector:
    def __init__(self, settings: Settings, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self.settings = settings
        self.sessionmaker = sessionmaker
        self._running = False
        self._channels: list[str] = []
        self._last_scan_at: datetime | None = None
        self._last_scan_messages = 0
        self._last_scan_matches = 0
        self._last_error: str | None = None
        self._throttle_lock = asyncio.Lock()
        self._next_request_at = 0.0
        self._semaphore = asyncio.Semaphore(3)

    @property
    def configured_channels(self) -> list[str]:
        raw = self.settings.telegram_public_web_channels.strip() or self.settings.telegram_monitor_channels.strip()
        result: list[str] = []
        for item in raw.split(","):
            normalized = normalize_telegram_target(item)
            if normalized and normalized not in result:
                result.append(normalized)
        return result

    def status(self) -> dict[str, Any]:
        return {
            "enabled": bool(self.settings.telegram_public_web_enabled),
            "configured": bool(self.settings.telegram_public_web_enabled and self.configured_channels),
            "running": self._running,
            "channels": list(self._channels or self.configured_channels),
            "last_scan_at": self._last_scan_at.isoformat() if self._last_scan_at else None,
            "last_scan_messages": self._last_scan_messages,
            "last_scan_matches": self._last_scan_matches,
            "last_error": self._last_error,
        }

    async def close(self) -> None:
        return None

    async def _throttle(self) -> None:
        loop = asyncio.get_running_loop()
        async with self._throttle_lock:
            delay = self._next_request_at - loop.time()
            if delay > 0:
                await asyncio.sleep(delay)
            self._next_request_at = loop.time() + _REQUEST_INTERVAL_SECONDS

    @staticmethod
    def _fetch_sync(url: str, timeout: float) -> tuple[str, str]:
        request = Request(
            url,
            headers={
                "User-Agent": _USER_AGENT,
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.8",
            },
            method="GET",
        )
        with urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed t.me URL only
            final_url = response.geturl()
            body = response.read(_MAX_RESPONSE_BYTES + 1)
            if len(body) > _MAX_RESPONSE_BYTES:
                raise TelegramPublicWebError("Telegram public page exceeded response size limit")
            charset = response.headers.get_content_charset() or "utf-8"
            return final_url, body.decode(charset, errors="replace")

    async def _fetch(self, url: str) -> str:
        timeout = float(self.settings.telegram_public_web_timeout_seconds)
        attempts = 1 + len(_RETRY_DELAYS_SECONDS)
        for attempt in range(attempts):
            await self._throttle()
            try:
                async with self._semaphore:
                    final_url, html = await asyncio.to_thread(self._fetch_sync, url, timeout)
                if not final_url.startswith("https://t.me/s/"):
                    raise TelegramPublicWebUnavailable("Telegram public page redirected outside public preview")
                return html
            except HTTPError as exc:
                if exc.code in {401, 403, 404}:
                    raise TelegramPublicWebUnavailable(f"Telegram public page unavailable ({exc.code})") from exc
                if exc.code != 429 and exc.code < 500:
                    raise TelegramPublicWebError(f"Telegram public page HTTP {exc.code}") from exc
                if attempt >= attempts - 1:
                    raise TelegramPublicWebError(f"Telegram public page HTTP {exc.code}") from exc
            except (URLError, TimeoutError, OSError) as exc:
                if attempt >= attempts - 1:
                    raise TelegramPublicWebError("Telegram public page network error") from exc
            if attempt < len(_RETRY_DELAYS_SECONDS):
                await asyncio.sleep(_RETRY_DELAYS_SECONDS[attempt])
        raise TelegramPublicWebError("Telegram public page request failed")

    async def _load_channel(self, username: str, limit: int) -> list[PublicTelegramMessage]:
        messages: dict[int, PublicTelegramMessage] = {}
        before: int | None = None
        max_pages = min(_MAX_PAGES_PER_CHANNEL, max(1, (limit + 19) // 20 + 1))
        for page_index in range(max_pages):
            url = f"https://t.me/s/{username}"
            if before is not None:
                url += f"?before={before}"
            html = await self._fetch(url)
            page = [item for item in parse_public_telegram_html(html) if item.channel_username == username]
            if not page:
                if page_index == 0:
                    raise TelegramPublicWebUnavailable("Telegram public preview exposed no messages")
                break
            new_count = 0
            for item in page:
                if item.message_id not in messages:
                    messages[item.message_id] = item
                    new_count += 1
            if len(messages) >= limit or new_count == 0:
                break
            oldest = min(item.message_id for item in page)
            if before is not None and oldest >= before:
                break
            before = oldest
        ordered = sorted(messages.values(), key=lambda item: item.message_id, reverse=True)
        return ordered[:limit]

    async def _upsert_channel(self, session: AsyncSession, username: str) -> TelegramChannel:
        row = (
            await session.execute(
                select(TelegramChannel).where(func.lower(TelegramChannel.username) == username.lower()).limit(1)
            )
        ).scalar_one_or_none()
        now = utcnow()
        if row is None:
            row = TelegramChannel(
                telegram_id=_public_channel_id(username),
                username=username,
                title=username,
                entity_type="channel",
                participants=0,
                about="",
                first_seen_at=now,
                last_seen_at=now,
                last_scanned_at=now,
                meta={"collector": "public_web", "public_web": True},
            )
            session.add(row)
        else:
            row.username = username
            row.last_seen_at = now
            row.last_scanned_at = now
            row.meta = {**(row.meta or {}), "public_web": True}
        await session.flush()
        return row

    async def _save_message(
        self,
        session: AsyncSession,
        channel: TelegramChannel,
        message: PublicTelegramMessage,
    ) -> int:
        if message.published_at is None:
            return 0
        evidence = _message_evidence(message)
        parsed = parse_telegram_message(evidence)
        stored = (
            await session.execute(
                select(TelegramMessage).where(
                    TelegramMessage.channel_id == channel.id,
                    TelegramMessage.telegram_message_id == message.message_id,
                )
            )
        ).scalar_one_or_none()
        is_new = stored is None
        raw = {
            "collector": "public_web",
            "views_available": message.views is not None,
            "forwarded_from": message.forwarded_from,
            "reply_url": message.reply_url,
            "links": message.links,
        }
        values = {
            "sender_id": None,
            "sender_telegram_id": None,
            "sender_username": channel.username,
            "sender_name": channel.title,
            "published_at": message.published_at,
            "edited_at": None,
            "text": message.text,
            "views": message.views or 0,
            "forwards": 0,
            "replies": 0,
            "reactions": 0,
            "raw": raw,
        }
        if stored is None:
            stored = TelegramMessage(channel_id=channel.id, telegram_message_id=message.message_id, **values)
            session.add(stored)
        else:
            for key, value in values.items():
                setattr(stored, key, value)
        await session.flush()

        source_handle = (channel.username or str(channel.telegram_id)).lower()
        if is_new:
            for target in parsed.telegram_usernames:
                if target != source_handle:
                    await upsert_social_relation(
                        session,
                        source_platform="telegram",
                        source_handle=source_handle,
                        target_platform="telegram",
                        target_handle=target,
                        relation_type="mention",
                        evidence=evidence,
                        occurred_at=message.published_at,
                    )
            for target in parsed.x_usernames:
                await upsert_social_relation(
                    session,
                    source_platform="telegram",
                    source_handle=source_handle,
                    target_platform="x",
                    target_handle=target,
                    relation_type="link",
                    evidence=evidence,
                    occurred_at=message.published_at,
                )

        ticker = parsed.tickers[0] if parsed.tickers else None
        created = 0
        for mint in parsed.addresses:
            mention = (
                await session.execute(
                    select(TelegramTokenMention).where(
                        TelegramTokenMention.message_id == stored.id,
                        TelegramTokenMention.mint_address == mint,
                    )
                )
            ).scalar_one_or_none()
            if mention is None:
                mention = TelegramTokenMention(
                    message_id=stored.id,
                    channel_id=channel.id,
                    mint_address=mint,
                    ticker=ticker,
                    first_seen_at=message.published_at,
                    source_url=message.url,
                    is_explicit_call=parsed.explicit_call,
                )
                session.add(mention)
                await session.flush()
                created += 1
            else:
                mention.ticker = ticker or mention.ticker
                mention.source_url = message.url
                mention.is_explicit_call = mention.is_explicit_call or parsed.explicit_call

            call = (
                await session.execute(select(TelegramCall).where(TelegramCall.mention_id == mention.id))
            ).scalar_one_or_none()
            if call is None and parsed.explicit_call:
                price, market_cap = await nearest_token_snapshot(session, mint, message.published_at)
                session.add(
                    TelegramCall(
                        mention_id=mention.id,
                        channel_id=channel.id,
                        message_id=stored.id,
                        mint_address=mint,
                        caller_telegram_id=None,
                        caller_username=source_handle,
                        called_at=message.published_at,
                        is_explicit_call=True,
                        call_price_usd=price,
                        call_market_cap_usd=market_cap,
                        outcome="pending",
                        meta={"collector": "public_web"},
                    )
                )

            external_id = f"{source_handle}:{message.message_id}"
            event = (
                await session.execute(
                    select(SocialEvent).where(
                        SocialEvent.platform == "telegram",
                        SocialEvent.event_type == "token_mention",
                        SocialEvent.mint_address == mint,
                        or_(
                            SocialEvent.external_id == external_id,
                            SocialEvent.source_url == message.url,
                        ),
                    )
                )
            ).scalar_one_or_none()
            metrics: dict[str, Any] = {
                "explicit_call": parsed.explicit_call,
                "collector": "public_web",
            }
            if message.views is not None:
                metrics["views"] = message.views
            payload = {
                "collector": "public_web",
                "forwarded_from": message.forwarded_from,
                "reply_url": message.reply_url,
                "links": message.links,
            }
            if event is None:
                session.add(
                    SocialEvent(
                        platform="telegram",
                        event_type="token_mention",
                        external_id=external_id,
                        source_handle=source_handle,
                        source_name=channel.title,
                        source_url=message.url,
                        mint_address=mint,
                        symbol=ticker,
                        text=message.text,
                        occurred_at=message.published_at,
                        metrics=metrics,
                        payload=payload,
                    )
                )
            else:
                event.source_handle = source_handle
                event.source_name = channel.title
                event.source_url = message.url
                event.symbol = ticker or event.symbol
                event.text = message.text
                event.occurred_at = message.published_at
                event.metrics = {**(event.metrics or {}), **metrics}
                event.payload = {**(event.payload or {}), **payload}
        await session.flush()
        return created

    async def scan_channel(self, username: str, *, history_limit: int | None = None) -> dict[str, Any]:
        normalized = normalize_telegram_target(username)
        if not normalized:
            raise ValueError("A public Telegram channel username is required")
        limit = max(1, min(int(history_limit or self.settings.telegram_public_web_history_limit), 500))
        messages = await self._load_channel(normalized, limit)
        saved = matches = 0
        async with self.sessionmaker() as session:
            channel = await self._upsert_channel(session, normalized)
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
            "username": normalized,
            "posts_saved": saved,
            "token_mentions_created": matches,
        }

    async def scan_channels(
        self,
        channels: list[str] | None = None,
        *,
        history_limit: int | None = None,
    ) -> dict[str, Any]:
        if not self.settings.telegram_public_web_enabled:
            raise TelegramPublicWebUnavailable("TG_PUBLIC_WEB_ENABLED is false")
        cleaned: list[str] = []
        for item in channels or self.configured_channels:
            normalized = normalize_telegram_target(item)
            if normalized and normalized not in cleaned:
                cleaned.append(normalized)
        if not cleaned:
            raise TelegramPublicWebUnavailable("No public Telegram channels are configured")

        self._running = True
        self._channels = cleaned
        self._last_error = None
        self._last_scan_at = None
        results: list[dict[str, Any]] = []
        try:
            async def run_one(channel: str) -> dict[str, Any]:
                try:
                    return await self.scan_channel(channel, history_limit=history_limit)
                except TelegramPublicWebError as exc:
                    return {"username": channel, "collector": "public_web", "error": str(exc)}

            results = await asyncio.gather(*(run_one(channel) for channel in cleaned))
            self._last_scan_messages = sum(int(row.get("posts_saved") or 0) for row in results)
            self._last_scan_matches = sum(int(row.get("token_mentions_created") or 0) for row in results)
            successful = [row for row in results if not row.get("error")]
            errors = [str(row.get("error")) for row in results if row.get("error")]
            self._last_error = errors[0] if errors and not successful else None
            self._last_scan_at = utcnow() if successful else None
            return {
                "collector": "public_web",
                "processed": len(results),
                "successful": len(successful),
                "posts_saved": self._last_scan_messages,
                "token_mentions_created": self._last_scan_matches,
                "results": results,
            }
        finally:
            self._running = False
