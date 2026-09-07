from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import event

from app.models.social_intelligence import (
    SocialEvent,
    TelegramCall,
    TelegramChannel,
    TelegramMessage,
    TelegramTokenMention,
)
from app.services.telegram_token_hot import (
    relevant_caller_reputation,
    telegram_token_intelligence_hot,
)


async def _add_call(
    session,
    *,
    channel: TelegramChannel,
    message_id: int,
    mint: str,
    called_at: datetime,
    caller: str,
    outcome: str = "loss",
    roi: float | None = 1.0,
) -> None:
    message = TelegramMessage(
        channel_id=channel.id,
        telegram_message_id=message_id,
        published_at=called_at,
        text=f"call {mint}",
        raw={},
    )
    session.add(message)
    await session.flush()
    mention = TelegramTokenMention(
        message_id=message.id,
        channel_id=channel.id,
        mint_address=mint,
        first_seen_at=called_at,
        is_explicit_call=True,
    )
    session.add(mention)
    await session.flush()
    session.add(
        TelegramCall(
            mention_id=mention.id,
            channel_id=channel.id,
            message_id=message.id,
            mint_address=mint,
            caller_username=caller,
            called_at=called_at,
            is_explicit_call=True,
            call_market_cap_usd=25_000,
            roi_multiple=roi,
            outcome=outcome,
        )
    )


async def test_relevant_caller_reputation_filters_history_in_one_query(test_app) -> None:
    now = datetime.now(timezone.utc)
    current_mint = "mint-current-hot-caller"
    async with test_app.state.sessionmaker() as session:
        alpha = TelegramChannel(telegram_id=8101, username="Alpha", title="Alpha")
        noise = TelegramChannel(telegram_id=8102, username="Noise", title="Noise")
        session.add_all([alpha, noise])
        await session.flush()

        await _add_call(
            session,
            channel=alpha,
            message_id=1,
            mint="mint-alpha-history",
            called_at=now - timedelta(days=2),
            caller="@Alpha",
            outcome="loss",
            roi=1.1,
        )
        # A current-token win must not leak into its own historical reputation.
        await _add_call(
            session,
            channel=alpha,
            message_id=2,
            mint=current_mint,
            called_at=now - timedelta(minutes=5),
            caller="@Alpha",
            outcome="win",
            roi=5.0,
        )
        for index in range(40):
            await _add_call(
                session,
                channel=noise,
                message_id=100 + index,
                mint=f"mint-noise-{index}",
                called_at=now - timedelta(hours=index + 1),
                caller="noise",
                outcome="win",
                roi=3.0,
            )
        await session.commit()

        statements: list[str] = []

        def record_select(_conn, _cursor, statement, *_args) -> None:
            if statement.lstrip().upper().startswith("SELECT"):
                statements.append(statement)

        event.listen(
            test_app.state.engine.sync_engine,
            "before_cursor_execute",
            record_select,
        )
        try:
            rows = await relevant_caller_reputation(
                session,
                usernames={"alpha"},
                exclude_mint=current_mint,
                limit=10,
            )
        finally:
            event.remove(
                test_app.state.engine.sync_engine,
                "before_cursor_execute",
                record_select,
            )

    assert len(statements) == 1
    assert len(rows) == 1
    assert rows[0]["username"] == "alpha"
    assert rows[0]["calls"] == 1
    assert rows[0]["wins"] == 0
    assert rows[0]["win_rate"] == 0.0


async def test_token_intelligence_uses_relevant_history_and_preserves_first_call(test_app) -> None:
    now = datetime.now(timezone.utc)
    mint = "mint-token-intelligence-hot"
    async with test_app.state.sessionmaker() as session:
        alpha = TelegramChannel(telegram_id=8201, username="alpha", title="Alpha")
        noise = TelegramChannel(telegram_id=8202, username="noise", title="Noise")
        session.add_all([alpha, noise])
        await session.flush()
        await _add_call(
            session,
            channel=alpha,
            message_id=1001,
            mint="mint-old-alpha",
            called_at=now - timedelta(days=1),
            caller="alpha",
            outcome="win",
            roi=2.5,
        )
        await _add_call(
            session,
            channel=alpha,
            message_id=1002,
            mint=mint,
            called_at=now - timedelta(minutes=20),
            caller="alpha",
            outcome="pending",
            roi=None,
        )
        for index in range(10):
            await _add_call(
                session,
                channel=noise,
                message_id=1100 + index,
                mint=f"mint-unrelated-{index}",
                called_at=now - timedelta(hours=index + 2),
                caller="noise",
                outcome="win",
                roi=4.0,
            )
        session.add(
            SocialEvent(
                platform="telegram",
                event_type="token_call",
                external_id="coord-alpha",
                source_handle="alpha",
                mint_address=mint,
                text="alpha original call",
                occurred_at=now - timedelta(minutes=20),
                payload={},
            )
        )
        await session.commit()

        result = await telegram_token_intelligence_hot(session, mint)

    assert result["first_call"]["source"] == "alpha"
    assert result["callers"][0]["username"] == "alpha"
    assert result["callers"][0]["calls"] == 1
    assert all(row["username"] != "noise" for row in result["callers"])
