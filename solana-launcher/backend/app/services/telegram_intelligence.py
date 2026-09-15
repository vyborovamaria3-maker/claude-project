from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.tl.functions.channels import GetFullChannelRequest
from telethon.tl.types import Channel

from app.core.config import Settings
from app.models.social_intelligence import (
    SocialEvent,
    TelegramCall,
    TelegramChannel,
    TelegramMessage,
    TelegramTokenMention,
    TelegramUser,
)
from app.services.social_intelligence import nearest_token_snapshot, upsert_channel_score
from app.services.social_relations import upsert_social_relation
from app.services.telegram_parser import (
    ParsedTelegramMessage,
    normalize_telegram_target,
    parse_telegram_message,
)


def utcnow() -> datetime:
    return datetime.now(UTC)


def aware(value: datetime | None) -> datetime:
    if value is None:
        return utcnow()
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def message_replies(message: Any) -> int:
    return int(getattr(getattr(message, "replies", None), "replies", 0) or 0)


def message_reactions(message: Any) -> int:
    rows = getattr(getattr(message, "reactions", None), "results", None) or []
    return sum(int(getattr(row, "count", 0) or 0) for row in rows)


class TelegramSessionError(RuntimeError):
    pass


class TelegramIntelligenceService:
    def __init__(
        self,
        settings: Settings,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        session_string: str | None = None,
    ) -> None:
        if not settings.telegram_api_id or not settings.telegram_api_hash:
            raise TelegramSessionError("TG_API_ID and TG_API_HASH are required")
        self.settings = settings
        self.sessionmaker = sessionmaker
        configured = session_string or settings.telegram_session_string
        if configured:
            session = StringSession(configured)
        else:
            session_path = Path(settings.telegram_session_path)
            session_path.parent.mkdir(parents=True, exist_ok=True)
            session = str(session_path)
        self.client = TelegramClient(session, settings.telegram_api_id, settings.telegram_api_hash)
        self._handler: Callable[[Any], Awaitable[None]] | None = None
        self._monitored: list[str] = []

    async def connect(self) -> None:
        await self.client.connect()
        if not await self.client.is_user_authorized():
            await self.client.disconnect()
            raise TelegramSessionError(
                "Telegram user session is not authorized. Run "
                "`python -m app.cli.telegram_login` and configure TG_SESSION_STRING."
            )

    async def disconnect(self) -> None:
        if self._handler is not None:
            self.client.remove_event_handler(self._handler)
            self._handler = None
        await self.client.disconnect()

    async def upsert_channel(self, session: AsyncSession, entity: Channel) -> TelegramChannel:
        try:
            full = await self.client(GetFullChannelRequest(entity))
            about = getattr(full.full_chat, "about", "") or ""
            participants = int(getattr(full.full_chat, "participants_count", 0) or 0)
            linked_chat_id = getattr(full.full_chat, "linked_chat_id", None)
            linked_chat = next(
                (
                    chat
                    for chat in getattr(full, "chats", [])
                    if getattr(chat, "id", None) == linked_chat_id
                ),
                None,
            )
            linked_username = (
                getattr(linked_chat, "username", None) if linked_chat is not None else None
            )
        except Exception:
            about = ""
            participants = int(getattr(entity, "participants_count", 0) or 0)
            linked_chat_id = None
            linked_username = None
        entity_username = getattr(entity, "username", None)
        row = (
            await session.execute(
                select(TelegramChannel).where(TelegramChannel.telegram_id == int(entity.id))
            )
        ).scalar_one_or_none()
        if row is None and entity_username:
            public_row = (
                await session.execute(
                    select(TelegramChannel)
                    .where(func.lower(TelegramChannel.username) == entity_username.lower())
                    .limit(1)
                )
            ).scalar_one_or_none()
            if (
                public_row is not None
                and public_row.telegram_id < 0
                and bool((public_row.meta or {}).get("public_web"))
            ):
                public_row.telegram_id = int(entity.id)
                row = public_row
        now = utcnow()
        values = {
            "username": entity_username,
            "title": getattr(entity, "title", None) or entity_username or str(entity.id),
            "entity_type": "group" if bool(getattr(entity, "megagroup", False)) else "channel",
            "participants": participants,
            "about": about,
        }
        meta = {
            "collector": "mtproto",
            "broadcast": bool(getattr(entity, "broadcast", False)),
            "linked_chat_id": linked_chat_id,
            "linked_username": linked_username,
        }
        if row is None:
            row = TelegramChannel(
                telegram_id=int(entity.id),
                first_seen_at=now,
                last_seen_at=now,
                last_scanned_at=now,
                meta=meta,
                **values,
            )
            session.add(row)
        else:
            for key, value in values.items():
                if value is not None:
                    setattr(row, key, value)
            row.last_seen_at = now
            row.last_scanned_at = now
            row.meta = {**(row.meta or {}), **meta}
        await session.flush()
        return row

    async def upsert_sender(self, session: AsyncSession, message: Any) -> TelegramUser | None:
        sender_id = getattr(message, "sender_id", None)
        if not sender_id:
            return None
        try:
            sender = await message.get_sender()
        except Exception:
            sender = None
        row = (
            await session.execute(
                select(TelegramUser).where(TelegramUser.telegram_id == int(sender_id))
            )
        ).scalar_one_or_none()
        username = getattr(sender, "username", None) if sender is not None else None
        first = getattr(sender, "first_name", None) if sender is not None else None
        last = getattr(sender, "last_name", None) if sender is not None else None
        display_name = " ".join(value for value in (first, last) if value) or username
        now = utcnow()
        if row is None:
            row = TelegramUser(
                telegram_id=int(sender_id),
                username=username,
                display_name=display_name,
                first_seen_at=now,
                last_seen_at=now,
                meta={"bot": bool(getattr(sender, "bot", False)) if sender is not None else False},
            )
            session.add(row)
        else:
            row.username = username or row.username
            row.display_name = display_name or row.display_name
            row.last_seen_at = now
        await session.flush()
        return row

    async def save_message(
        self,
        session: AsyncSession,
        channel: TelegramChannel,
        message: Any,
        *,
        update_score: bool = True,
    ) -> tuple[ParsedTelegramMessage, int]:
        text = getattr(message, "message", None) or ""
        parsed = parse_telegram_message(text)
        sender = await self.upsert_sender(session, message)
        sender_telegram_id = getattr(message, "sender_id", None)
        published_at = aware(getattr(message, "date", None))
        stored = (
            await session.execute(
                select(TelegramMessage).where(
                    TelegramMessage.channel_id == channel.id,
                    TelegramMessage.telegram_message_id == int(message.id),
                )
            )
        ).scalar_one_or_none()
        is_new_message = stored is None
        values = {
            "sender_id": sender.id if sender else None,
            "sender_telegram_id": int(sender_telegram_id) if sender_telegram_id else None,
            "sender_username": sender.username if sender else None,
            "sender_name": sender.display_name if sender else None,
            "published_at": published_at,
            "edited_at": aware(message.edit_date) if getattr(message, "edit_date", None) else None,
            "text": text,
            "views": int(getattr(message, "views", 0) or 0),
            "forwards": int(getattr(message, "forwards", 0) or 0),
            "replies": message_replies(message),
            "reactions": message_reactions(message),
            "raw": {
                "collector": "mtproto",
                "grouped_id": str(getattr(message, "grouped_id", "") or "") or None,
            },
        }
        if stored is None:
            stored = TelegramMessage(
                channel_id=channel.id, telegram_message_id=int(message.id), **values
            )
            session.add(stored)
        else:
            for key, value in values.items():
                setattr(stored, key, value)
        await session.flush()

        source_handle = (channel.username or str(channel.telegram_id)).lower()
        if is_new_message:
            for target in parsed.telegram_usernames:
                if target != source_handle:
                    await upsert_social_relation(
                        session,
                        source_platform="telegram",
                        source_handle=source_handle,
                        target_platform="telegram",
                        target_handle=target,
                        relation_type="mention",
                        evidence=text,
                        occurred_at=published_at,
                    )
            for target in parsed.x_usernames:
                await upsert_social_relation(
                    session,
                    source_platform="telegram",
                    source_handle=source_handle,
                    target_platform="x",
                    target_handle=target,
                    relation_type="link",
                    evidence=text,
                    occurred_at=published_at,
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
            source_url = (
                f"https://t.me/{channel.username}/{stored.telegram_message_id}"
                if channel.username
                else None
            )
            if mention is None:
                mention = TelegramTokenMention(
                    message_id=stored.id,
                    channel_id=channel.id,
                    mint_address=mint,
                    ticker=ticker,
                    first_seen_at=published_at,
                    source_url=source_url,
                    is_explicit_call=parsed.explicit_call,
                )
                session.add(mention)
                await session.flush()
                created += 1
            else:
                mention.ticker = ticker or mention.ticker
                mention.source_url = source_url or mention.source_url
                mention.is_explicit_call = mention.is_explicit_call or parsed.explicit_call

            call = (
                await session.execute(
                    select(TelegramCall).where(TelegramCall.mention_id == mention.id)
                )
            ).scalar_one_or_none()
            if call is None and parsed.explicit_call:
                price, market_cap = await nearest_token_snapshot(session, mint, published_at)
                session.add(
                    TelegramCall(
                        mention_id=mention.id,
                        channel_id=channel.id,
                        message_id=stored.id,
                        mint_address=mint,
                        caller_telegram_id=stored.sender_telegram_id,
                        caller_username=stored.sender_username or source_handle,
                        called_at=published_at,
                        is_explicit_call=parsed.explicit_call,
                        call_price_usd=price,
                        call_market_cap_usd=market_cap,
                        outcome="pending",
                        meta={"collector": "mtproto"},
                    )
                )
            elif call is not None:
                call.caller_telegram_id = stored.sender_telegram_id or call.caller_telegram_id
                call.caller_username = (
                    stored.sender_username or call.caller_username or source_handle
                )
                call.meta = {**(call.meta or {}), "collector": "mtproto"}

            external_id = f"{channel.telegram_id}:{stored.telegram_message_id}"
            event_conditions = [SocialEvent.external_id == external_id]
            if source_url:
                event_conditions.append(SocialEvent.source_url == source_url)
            event = (
                await session.execute(
                    select(SocialEvent).where(
                        SocialEvent.platform == "telegram",
                        SocialEvent.event_type == "token_mention",
                        SocialEvent.mint_address == mint,
                        or_(*event_conditions),
                    )
                )
            ).scalar_one_or_none()
            metrics = {
                "views": stored.views,
                "forwards": stored.forwards,
                "replies": stored.replies,
                "reactions": stored.reactions,
                "explicit_call": parsed.explicit_call,
                "collector": "mtproto",
            }
            payload = {
                "collector": "mtproto",
                "sender_username": stored.sender_username,
                "sender_telegram_id": stored.sender_telegram_id,
            }
            if event is None:
                session.add(
                    SocialEvent(
                        platform="telegram",
                        event_type="token_mention",
                        external_id=external_id,
                        source_handle=source_handle,
                        source_name=channel.title,
                        source_url=source_url,
                        mint_address=mint,
                        symbol=ticker,
                        text=text,
                        occurred_at=published_at,
                        metrics=metrics,
                        payload=payload,
                    )
                )
            else:
                event.source_handle = source_handle
                event.source_name = channel.title
                event.source_url = source_url
                event.symbol = ticker or event.symbol
                event.text = text
                event.occurred_at = published_at
                event.metrics = {**(event.metrics or {}), **metrics}
                event.payload = {**(event.payload or {}), **payload}
        await session.flush()
        if update_score and parsed.addresses:
            await upsert_channel_score(session, channel.id)
        return parsed, created

    async def scan_channel(self, username: str, *, post_limit: int = 200) -> dict[str, Any]:
        entity = await self.client.get_entity(username)
        if not isinstance(entity, Channel):
            raise ValueError("Entity is not a Telegram channel or group")
        discovered_tg: set[str] = set()
        discovered_x: set[str] = set()
        saved = mentions = 0
        async with self.sessionmaker() as session:
            channel = await self.upsert_channel(session, entity)
            source_handle = (channel.username or str(channel.telegram_id)).lower()
            profile = parse_telegram_message(channel.about)
            discovered_tg.update(profile.telegram_links)
            discovered_x.update(profile.x_usernames)
            linked_username = str((channel.meta or {}).get("linked_username") or "").lower()
            if linked_username:
                discovered_tg.add(linked_username)
                await upsert_social_relation(
                    session,
                    source_platform="telegram",
                    source_handle=source_handle,
                    target_platform="telegram",
                    target_handle=linked_username,
                    relation_type="discussion",
                    evidence="linked discussion chat",
                )
            async for message in self.client.iter_messages(
                entity, limit=max(1, min(post_limit, 5000))
            ):
                parsed, created = await self.save_message(
                    session, channel, message, update_score=False
                )
                discovered_tg.update(parsed.telegram_links)
                discovered_x.update(parsed.x_usernames)
                saved += 1
                mentions += created
            if mentions:
                await upsert_channel_score(session, channel.id)
            channel.last_scanned_at = utcnow()
            await session.commit()
        return {
            "platform": "telegram",
            "username": channel.username or username,
            "channel_id": channel.id,
            "telegram_id": channel.telegram_id,
            "entity_type": channel.entity_type,
            "posts_saved": saved,
            "token_mentions_created": mentions,
            "discovered_telegram": sorted(discovered_tg),
            "discovered_x": sorted(discovered_x),
        }

    async def scan_graph(
        self,
        seeds: list[str],
        *,
        max_depth: int = 2,
        post_limit: int = 200,
        entity_limit: int = 100,
    ) -> dict[str, Any]:
        queue = [
            (normalize_telegram_target(seed), 0)
            for seed in seeds
            if normalize_telegram_target(seed)
        ]
        seen: set[str] = set()
        results: list[dict[str, Any]] = []
        while queue and len(results) < max(1, min(entity_limit, 1000)):
            username, depth = queue.pop(0)
            key = username.lower()
            if not key or key in seen or depth > max_depth:
                continue
            seen.add(key)
            try:
                result = await self.scan_channel(username, post_limit=post_limit)
                result["depth"] = depth
                results.append(result)
                if depth < max_depth:
                    queue.extend(
                        (target, depth + 1)
                        for target in result["discovered_telegram"]
                        if target.lower() not in seen
                    )
            except Exception as exc:
                results.append({"username": username, "depth": depth, "error": str(exc)})
        return {"processed": len(results), "results": results}

    async def start_monitor(self, channels: list[str]) -> dict[str, Any]:
        if self._handler is not None:
            return {"running": True, "channels": self._monitored}
        cleaned = [
            normalize_telegram_target(item) for item in channels if normalize_telegram_target(item)
        ]
        if not cleaned:
            raise ValueError("At least one Telegram channel is required")
        resolved = []
        for value in cleaned:
            entity = await self.client.get_entity(value)
            if isinstance(entity, Channel):
                resolved.append(entity)
        if not resolved:
            raise ValueError("No Telegram channels/groups could be resolved")

        async def handler(event: events.NewMessage.Event) -> None:
            try:
                entity = await event.get_chat()
                if not isinstance(entity, Channel):
                    return
                async with self.sessionmaker() as session:
                    channel = await self.upsert_channel(session, entity)
                    await self.save_message(session, channel, event.message)
                    await session.commit()
            except Exception:
                return

        self._handler = handler
        self.client.add_event_handler(handler, events.NewMessage(chats=resolved))
        self._monitored = cleaned
        return {"running": True, "channels": cleaned}

    async def stop_monitor(self) -> dict[str, Any]:
        if self._handler is not None:
            self.client.remove_event_handler(self._handler)
            self._handler = None
        previous = self._monitored
        self._monitored = []
        return {"running": False, "channels": previous}

    def monitor_status(self) -> dict[str, Any]:
        return {
            "running": self._handler is not None and self.client.is_connected(),
            "channels": self._monitored,
            "connected": self.client.is_connected(),
        }
