from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.dialects import postgresql

from app.models.social_intelligence import SocialEvent
from app.services.social_search import (
    postgres_social_search_statement,
    search_social_events,
)


async def test_social_search_fallback_filters_mint_platform_and_bounds_results(
    test_app,
) -> None:
    now = datetime.now(timezone.utc)
    async with test_app.state.sessionmaker() as session:
        session.add_all(
            [
                SocialEvent(
                    platform="x",
                    event_type="token_mention",
                    external_id="search-x-new",
                    source_handle="alpha",
                    mint_address="mint-search-a",
                    text="smart money accumulation around this token",
                    occurred_at=now - timedelta(minutes=5),
                ),
                SocialEvent(
                    platform="x",
                    event_type="token_mention",
                    external_id="search-x-old",
                    source_handle="beta",
                    mint_address="mint-search-a",
                    text="smart money entered earlier",
                    occurred_at=now - timedelta(minutes=10),
                ),
                SocialEvent(
                    platform="telegram",
                    event_type="token_call",
                    external_id="search-tg",
                    source_handle="calls",
                    mint_address="mint-search-a",
                    text="smart money telegram call",
                    occurred_at=now - timedelta(minutes=2),
                ),
                SocialEvent(
                    platform="x",
                    event_type="token_mention",
                    external_id="search-other-mint",
                    source_handle="gamma",
                    mint_address="mint-search-b",
                    text="smart money on another mint",
                    occurred_at=now - timedelta(minutes=1),
                ),
            ]
        )
        await session.commit()

        rows = await search_social_events(
            session,
            query="smart money",
            mint_address="mint-search-a",
            platform="x",
            hours=1,
            limit=1,
        )

    assert len(rows) == 1
    assert rows[0]["external_id"] == "search-x-new"
    assert rows[0]["platform"] == "x"
    assert rows[0]["mint_address"] == "mint-search-a"
    assert rows[0]["search_mode"] == "bounded_substring_fallback"


def test_postgres_social_search_compiles_to_fts_trigram_and_bounded_limit() -> None:
    statement = postgres_social_search_statement(
        query="smart money",
        mint_address="mint-a",
        platform="telegram",
        hours=24,
        limit=17,
    )
    sql = str(
        statement.compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    ).lower()
    assert "to_tsvector('simple'" in sql
    assert "websearch_to_tsquery('simple'" in sql
    assert "similarity(" in sql
    assert "social_events.mint_address = 'mint-a'" in sql
    assert "lower(social_events.platform) = 'telegram'" in sql
    assert "limit 17" in sql
