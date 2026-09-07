from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.models.analytics import Token, TokenLatestMetric, TokenMetric


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


async def test_latest_metric_preserves_last_known_fields_and_monotonic_ath(test_app) -> None:
    first_at = datetime(2026, 9, 7, 10, 0, tzinfo=timezone.utc)
    second_at = first_at + timedelta(minutes=5)

    async with test_app.state.sessionmaker() as session:
        token = Token(
            mint_address="latest-known-metric",
            name="Latest Known",
            symbol="LKM",
        )
        session.add(token)
        await session.flush()

        first = TokenMetric(
            token_id=token.id,
            timestamp=first_at,
            price_usd=10.0,
            ath_usd=10.0,
            ath_date=first_at,
            market_cap=1000.0,
            liquidity_usd=250.0,
            holder_count=100,
            twitter_url="https://x.com/example",
        )
        session.add(first)
        await session.commit()

        second = TokenMetric(
            token_id=token.id,
            timestamp=second_at,
            price_usd=8.0,
            # A provider retry can leave these fields unknown. The hot projection
            # must not erase previously known values, and ATH must not move down.
            ath_usd=8.0,
            ath_date=second_at,
            market_cap=None,
            liquidity_usd=None,
            volume_24h=55.0,
            holder_count=None,
            twitter_url=None,
        )
        session.add(second)
        await session.commit()

        latest = await session.get(TokenLatestMetric, token.id)

    assert latest is not None
    assert latest.metric_id == second.id
    assert _utc(latest.timestamp) == second_at
    assert latest.price_usd == 8.0
    assert latest.ath_usd == 10.0
    assert latest.ath_date is not None
    assert _utc(latest.ath_date) == first_at
    assert latest.market_cap == 1000.0
    assert latest.liquidity_usd == 250.0
    assert latest.volume_24h == 55.0
    assert latest.holder_count == 100
    assert latest.twitter_url == "https://x.com/example"
