from datetime import datetime, timedelta, timezone

from sqlalchemy import event, select

from app.models.analytics import Token, TokenLatestMetric, TokenMetric, Wallet, WalletTrade
from app.services.analytics_queries import get_token_analysis, get_wallet_activity, list_tokens


async def test_list_tokens_sorts_latest_metrics_in_database(test_app):
    now = datetime(2026, 9, 6, tzinfo=timezone.utc)
    async with test_app.state.sessionmaker() as session:
        token_a = Token(mint_address="mint-a", name="Alpha", symbol="AAA")
        token_b = Token(mint_address="mint-b", name="Beta", symbol="BBB")
        token_c = Token(mint_address="mint-c", name="Gamma", symbol="CCC")
        session.add_all([token_a, token_b, token_c])
        await session.flush()

        session.add_all(
            [
                TokenMetric(
                    token_id=token_a.id,
                    timestamp=now - timedelta(hours=1),
                    volume_24h=999.0,
                    ath_usd=100.0,
                ),
                TokenMetric(
                    token_id=token_a.id,
                    timestamp=now,
                    volume_24h=10.0,
                    ath_usd=10.0,
                ),
                TokenMetric(
                    token_id=token_b.id,
                    timestamp=now,
                    volume_24h=50.0,
                    ath_usd=50.0,
                ),
                TokenMetric(
                    token_id=token_c.id,
                    timestamp=now,
                    volume_24h=30.0,
                    ath_usd=30.0,
                ),
                # A stale observation arriving later must not replace the hot row.
                TokenMetric(
                    token_id=token_b.id,
                    timestamp=now - timedelta(hours=2),
                    volume_24h=5000.0,
                    ath_usd=5000.0,
                ),
            ]
        )
        await session.commit()

        hot_b = (
            await session.execute(
                select(TokenLatestMetric).where(TokenLatestMetric.token_id == token_b.id)
            )
        ).scalar_one()
        items, total = await list_tokens(
            session,
            limit=2,
            offset=0,
            sort_by="volume",
            order="desc",
        )

    hot_timestamp = hot_b.timestamp
    if hot_timestamp.tzinfo is None:
        hot_timestamp = hot_timestamp.replace(tzinfo=timezone.utc)
    assert hot_timestamp == now
    assert hot_b.volume_24h == 50.0
    assert total == 3
    assert [item["symbol"] for item in items] == ["BBB", "CCC"]
    assert items[0]["latest_metric"]["timestamp"] is not None
    assert items[0]["latest_metric"]["volume_24h"] == 50.0


async def test_token_analysis_query_count_stays_bounded_with_large_history(test_app):
    now = datetime(2026, 9, 6, tzinfo=timezone.utc)
    async with test_app.state.sessionmaker() as session:
        token = Token(mint_address="analysis-mint", name="Analysis", symbol="ANL")
        session.add(token)
        await session.flush()
        token_id = token.id
        session.add_all(
            [
                TokenMetric(
                    token_id=token.id,
                    timestamp=now - timedelta(minutes=offset),
                    price_usd=float(200 - offset),
                    market_cap=float(1_000_000 - offset),
                    volume_24h=float(offset),
                )
                for offset in range(150)
            ]
        )
        await session.commit()

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
            data = await get_token_analysis(session, "analysis-mint")
    finally:
        event.remove(
            test_app.state.engine.sync_engine,
            "before_cursor_execute",
            record_select,
        )

    assert data["token"]["id"] == token_id
    assert len(data["metrics"]) == 100
    assert data["token"]["latest_metric"]["price_usd"] == 200.0
    # Token, hot metric, bounded metric history, top-wallet aggregate.
    assert len(statements) == 4


async def test_wallet_activity_is_paginated_but_summary_covers_all_trades(test_app):
    now = datetime(2026, 9, 6, tzinfo=timezone.utc)
    async with test_app.state.sessionmaker() as session:
        token_a = Token(mint_address="wallet-mint-a", symbol="WA")
        token_b = Token(mint_address="wallet-mint-b", symbol="WB")
        wallet = Wallet(wallet_address="wallet-address")
        session.add_all([token_a, token_b, wallet])
        await session.flush()

        session.add_all(
            [
                WalletTrade(
                    wallet_id=wallet.id,
                    token_id=token_a.id,
                    buy_timestamp=now - timedelta(minutes=3),
                    amount_buy=1.0,
                    amount_sold=1.0,
                    realized_profit_usd=1.0,
                ),
                WalletTrade(
                    wallet_id=wallet.id,
                    token_id=token_b.id,
                    buy_timestamp=now - timedelta(minutes=2),
                    amount_buy=1.0,
                    amount_sold=1.0,
                    realized_profit_usd=-2.0,
                ),
                WalletTrade(
                    wallet_id=wallet.id,
                    token_id=token_a.id,
                    buy_timestamp=now - timedelta(minutes=1),
                    amount_buy=1.0,
                    amount_sold=1.0,
                    realized_profit_usd=3.0,
                ),
            ]
        )
        await session.commit()

        data = await get_wallet_activity(
            session,
            "wallet-address",
            limit=1,
            offset=1,
        )

    assert data["meta"] == {"limit": 1, "offset": 1, "total": 3}
    assert len(data["trades"]) == 1
    assert data["trades"][0].realized_profit_usd == -2.0
    assert data["profit_total"] == 2.0
    assert data["token_count"] == 2
