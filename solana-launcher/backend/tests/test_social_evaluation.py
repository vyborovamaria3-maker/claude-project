from datetime import datetime, timedelta, timezone

from sqlalchemy import event, select

from app.models.analytics import Token, TokenMetric
from app.models.social_intelligence import (
    TelegramCall,
    TelegramChannel,
    TelegramChannelScore,
    TelegramMessage,
    TelegramTokenMention,
)
from app.services.social_evaluation import evaluate_calls


async def test_bulk_call_evaluation_uses_bounded_queries_and_updates_score(test_app):
    called_at = datetime(2026, 9, 6, 12, 0, tzinfo=timezone.utc)
    async with test_app.state.sessionmaker() as session:
        token = Token(mint_address="bulk-eval-mint", name="Bulk", symbol="BLK")
        channel = TelegramChannel(
            telegram_id=123456789,
            username="bulk_calls",
            title="Bulk Calls",
        )
        session.add_all([token, channel])
        await session.flush()

        for index in range(3):
            message = TelegramMessage(
                channel_id=channel.id,
                telegram_message_id=1000 + index,
                published_at=called_at,
                text="call bulk-eval-mint",
            )
            session.add(message)
            await session.flush()
            mention = TelegramTokenMention(
                message_id=message.id,
                channel_id=channel.id,
                mint_address=token.mint_address,
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
                    mint_address=token.mint_address,
                    called_at=called_at,
                    is_explicit_call=True,
                    outcome="pending",
                )
            )

        session.add_all(
            [
                TokenMetric(
                    token_id=token.id,
                    timestamp=called_at - timedelta(minutes=30),
                    price_usd=1.0,
                    market_cap=100.0,
                ),
                TokenMetric(
                    token_id=token.id,
                    timestamp=called_at + timedelta(hours=1),
                    price_usd=3.0,
                    market_cap=300.0,
                ),
                TokenMetric(
                    token_id=token.id,
                    timestamp=called_at + timedelta(hours=6),
                    price_usd=2.5,
                    market_cap=250.0,
                ),
            ]
        )
        await session.commit()
        channel_id = channel.id

    statements: list[str] = []

    def record_select(
        _conn,
        _cursor,
        statement,
        _parameters,
        _context,
        _executemany,
    ):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(
        test_app.state.engine.sync_engine,
        "before_cursor_execute",
        record_select,
    )
    try:
        async with test_app.state.sessionmaker() as session:
            result = await evaluate_calls(session, limit=100, window_hours=6)
    finally:
        event.remove(
            test_app.state.engine.sync_engine,
            "before_cursor_execute",
            record_select,
        )

    async with test_app.state.sessionmaker() as session:
        calls = list(
            (
                await session.execute(
                    select(TelegramCall).order_by(TelegramCall.id.asc())
                )
            ).scalars().all()
        )
        score = await session.get(TelegramChannelScore, channel_id)

    assert result["processed"] == 3
    assert result["finalized"] == 3
    assert result["channels_updated"] == 1
    assert all(call.call_market_cap_usd == 100.0 for call in calls)
    assert all(call.roi_multiple == 3.0 for call in calls)
    assert all(call.outcome == "win" for call in calls)
    assert all((call.meta or {}).get("bulk_evaluation") is True for call in calls)
    assert score is not None
    assert score.calls_count == 3
    assert score.evaluated_calls == 3
    assert score.successful_calls == 3
    assert score.early_calls == 3
    assert score.avg_roi == 3.0
    # Calls, token map, one metrics chunk, channel aggregate, existing scores.
    assert len(statements) == 5
