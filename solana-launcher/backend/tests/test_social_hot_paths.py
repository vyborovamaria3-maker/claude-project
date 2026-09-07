from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from app.models.social_intelligence import SocialEvent, TelegramChannel, TelegramChannelScore
from app.services.social_hot_paths import (
    channel_score_lookup,
    ingest_x_events_bulk,
    token_timeline_candidates,
)


async def test_x_ingest_batches_existing_lookup_and_deduplicates_payload(test_app):
    payload = {
        "token_mint": "mint-social-hot-path",
        "token_symbol": "HOT",
        "strategy": "test",
        "tweets": [
            {
                "id": "tweet-a",
                "text": "first observation",
                "author_handle": "alpha",
                "posted_at": 1_700_000_000,
                "likes": 5,
            },
            {
                "id": "tweet-b",
                "text": "second tweet",
                "author_handle": "beta",
                "posted_at": 1_700_000_100,
                "retweets": 3,
            },
            {
                "id": "tweet-a",
                "text": "last duplicate wins",
                "author_handle": "alpha",
                "posted_at": 1_700_000_200,
                "likes": 9,
            },
            {
                "id": "tweet-missing-time",
                "text": "skip me",
                "author_handle": "gamma",
            },
        ],
    }

    async with test_app.state.sessionmaker() as session:
        first = await ingest_x_events_bulk(session, payload)
        assert first == {
            "inserted": 2,
            "updated": 0,
            "skipped_missing_timestamp": 1,
        }

        stored = list(
            (
                await session.execute(
                    select(SocialEvent)
                    .where(SocialEvent.mint_address == "mint-social-hot-path")
                    .order_by(SocialEvent.external_id.asc())
                )
            ).scalars().all()
        )
        assert len(stored) == 2
        assert stored[0].external_id == "tweet-a"
        assert stored[0].text == "last duplicate wins"
        assert stored[0].metrics["likes"] == 9

        second_payload = {
            **payload,
            "tweets": [
                {
                    "id": "tweet-a",
                    "text": "updated A",
                    "posted_at": 1_700_000_300,
                    "likes": 11,
                },
                {
                    "id": "tweet-b",
                    "text": "updated B",
                    "posted_at": 1_700_000_400,
                    "retweets": 4,
                },
            ],
        }
        second = await ingest_x_events_bulk(session, second_payload)
        assert second == {
            "inserted": 0,
            "updated": 2,
            "skipped_missing_timestamp": 0,
        }
        count = int(
            await session.scalar(
                select(func.count())
                .select_from(SocialEvent)
                .where(SocialEvent.mint_address == "mint-social-hot-path")
            )
            or 0
        )
        assert count == 2


async def test_timeline_pushes_platform_and_time_filters_before_python_filtering(test_app):
    now = datetime.now(timezone.utc)
    mint = "mint-timeline-hot-path"
    async with test_app.state.sessionmaker() as session:
        session.add_all(
            [
                SocialEvent(
                    platform="x",
                    event_type="token_mention",
                    external_id="recent-x",
                    source_handle="alpha",
                    mint_address=mint,
                    text="recent x",
                    occurred_at=now - timedelta(minutes=10),
                ),
                SocialEvent(
                    platform="telegram",
                    event_type="token_mention",
                    external_id="recent-tg",
                    source_handle="beta",
                    mint_address=mint,
                    text="recent tg",
                    occurred_at=now - timedelta(minutes=5),
                ),
                SocialEvent(
                    platform="x",
                    event_type="token_mention",
                    external_id="old-x",
                    source_handle="alpha",
                    mint_address=mint,
                    text="old x",
                    occurred_at=now - timedelta(hours=4),
                ),
            ]
        )
        await session.commit()

        payload = await token_timeline_candidates(
            session,
            mint,
            platform="x",
            hours=1,
        )

    assert payload["mentions"] == 1
    assert payload["platforms"] == {"x": 1}
    assert payload["timeline"][0]["text"] == "recent x"


async def test_channel_score_lookup_reads_only_threshold_matches(test_app):
    async with test_app.state.sessionmaker() as session:
        alpha = TelegramChannel(
            telegram_id=9001,
            username="@AlphaCalls",
            title="Alpha Calls",
        )
        beta = TelegramChannel(
            telegram_id=9002,
            username="beta_calls",
            title="Beta Calls",
        )
        session.add_all([alpha, beta])
        await session.flush()
        session.add_all(
            [
                TelegramChannelScore(channel_id=alpha.id, score=82.5),
                TelegramChannelScore(channel_id=beta.id, score=25.0),
            ]
        )
        await session.commit()

        scores = await channel_score_lookup(session, min_score=50.0)

    assert scores["alphacalls"] == 82.5
    assert scores["9001"] == 82.5
    assert "beta_calls" not in scores
    assert "9002" not in scores
