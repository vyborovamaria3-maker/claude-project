from __future__ import annotations

from datetime import UTC, datetime

import pytest
from app.db.base import Base
from app.models.analytics import Token, TokenMetric, Wallet, WalletLink, WalletTrade
from app.models.intelligence_memory import IntelligenceSnapshot, IntelligenceSnapshotEntity
from app.models.social_intelligence import (
    SocialEvent,
    TelegramCall,
    TelegramChannel,
    TelegramChannelScore,
)
from app.services.intelligence_research import (
    execute_research_tools,
    expand_tg_channel,
    expand_wallet,
    expand_x_account,
    funding_graph,
    related_launches,
)
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

NOW = datetime(2026, 8, 12, 4, 0, tzinfo=UTC)
MINT_A = "3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump"
MINT_B = "So11111111111111111111111111111111111111112"
WALLET_A = "8YpQMWqkVJbR4QdQ8kCj4Yw2cBzX9rWv2KjC5uE1aBcD"
WALLET_B = "7XpQMWqkVJbR4QdQ8kCj4Yw2cBzX9rWv2KjC5uE1aBcE"


@pytest.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    tables = [
        Token.__table__,
        TokenMetric.__table__,
        Wallet.__table__,
        WalletTrade.__table__,
        WalletLink.__table__,
        SocialEvent.__table__,
        TelegramChannel.__table__,
        TelegramChannelScore.__table__,
        TelegramCall.__table__,
        IntelligenceSnapshot.__table__,
        IntelligenceSnapshotEntity.__table__,
    ]
    async with engine.begin() as connection:
        await connection.run_sync(
            lambda sync_connection: Base.metadata.create_all(
                sync_connection,
                tables=tables,
            )
        )
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db:
        yield db
    await engine.dispose()


@pytest.mark.asyncio
async def test_wallet_similarity_is_not_funding_proof(session) -> None:
    token = Token(mint_address=MINT_A, symbol="AAA")
    wallet_a = Wallet(wallet_address=WALLET_A, first_seen_date=NOW)
    wallet_b = Wallet(wallet_address=WALLET_B, first_seen_date=NOW)
    session.add_all([token, wallet_a, wallet_b])
    await session.flush()
    session.add(
        WalletTrade(
            wallet_id=wallet_a.id,
            token_id=token.id,
            buy_timestamp=NOW,
            amount_buy=10,
            realized_profit_usd=25,
        )
    )
    session.add(
        WalletLink(
            wallet_a_id=wallet_a.id,
            wallet_b_id=wallet_b.id,
            shared_tokens_count=4,
            similarity_score=0.93,
            details={"reason": "same tokens"},
        )
    )
    await session.commit()

    graph = await funding_graph(session, f"wallet:{WALLET_A}")
    assert graph["found"] is True
    assert graph["funding_evidence_available"] is False
    assert graph["explicit_funding_evidence"] == []
    assert len(graph["similarity_links_not_funding_proof"]) == 1

    wallet = await expand_wallet(session, f"wallet:{WALLET_A}")
    assert wallet["wallet"]["tokens_in_returned_trades"] == 1
    assert wallet["wallet_links"][0]["explicit_funding_evidence"] is None


@pytest.mark.asyncio
async def test_explicit_collector_funding_evidence_is_separate(session) -> None:
    wallet_a = Wallet(wallet_address=WALLET_A, first_seen_date=NOW)
    wallet_b = Wallet(wallet_address=WALLET_B, first_seen_date=NOW)
    session.add_all([wallet_a, wallet_b])
    await session.flush()
    session.add(
        WalletLink(
            wallet_a_id=wallet_a.id,
            wallet_b_id=wallet_b.id,
            shared_tokens_count=1,
            similarity_score=0.4,
            details={"funding_signature": "5abc", "transfer_sol": 2.5},
        )
    )
    await session.commit()

    graph = await funding_graph(session, f"wallet:{WALLET_A}")
    assert graph["funding_evidence_available"] is True
    assert graph["explicit_funding_evidence"][0]["evidence"]["funding_signature"] == "5abc"


@pytest.mark.asyncio
async def test_x_and_tg_expansion_have_bounded_semantics(session) -> None:
    session.add_all(
        [
            SocialEvent(
                platform="x",
                event_type="token_mention",
                external_id="x-1",
                source_handle="@alpha",
                mint_address=MINT_A,
                text="AAA",
                occurred_at=NOW,
            ),
            SocialEvent(
                platform="x",
                event_type="token_mention",
                external_id="x-2",
                source_handle="alpha",
                mint_address=MINT_B,
                text="BBB",
                occurred_at=NOW,
            ),
        ]
    )
    older = TelegramChannel(
        telegram_id=1,
        username="alpha_calls",
        title="Alpha Calls",
        participants=100,
        first_seen_at=NOW,
        last_seen_at=NOW,
    )
    newer = TelegramChannel(
        telegram_id=2,
        username="alpha_calls",
        title="Alpha Calls Mirror",
        participants=200,
        first_seen_at=NOW,
        last_seen_at=NOW.replace(minute=1),
    )
    session.add_all([older, newer])
    await session.flush()
    session.add(
        TelegramChannelScore(
            channel_id=newer.id,
            calls_count=10,
            evaluated_calls=8,
            successful_calls=5,
            rug_calls=1,
            early_calls=3,
            win_rate=0.625,
            rug_rate=0.125,
            avg_roi=2.4,
            score=71,
            updated_at=NOW,
        )
    )
    session.add(
        TelegramCall(
            mention_id=999,
            channel_id=newer.id,
            message_id=999,
            mint_address=MINT_A,
            called_at=NOW,
            is_explicit_call=True,
            outcome="win",
        )
    )
    await session.commit()

    x = await expand_x_account(session, "x_account:alpha")
    assert x["account"]["distinct_mints_in_returned_events"] == 2
    assert "mutable" in x["account"]["note"]

    tg = await expand_tg_channel(session, "tg_channel:alpha_calls")
    assert tg["channel"]["id"] == newer.id
    assert tg["channel"]["calls_count"] == 10
    assert tg["channel"]["calls_returned"] == 1


@pytest.mark.asyncio
async def test_related_launches_excludes_current_mint_and_planner_is_bounded(session) -> None:
    for snapshot_id, mint in [("snap-a", MINT_A), ("snap-b", MINT_B)]:
        session.add(
            IntelligenceSnapshot(
                snapshot_id=snapshot_id,
                mint_address=mint,
                symbol="AAA" if mint == MINT_A else "BBB",
                snapshot_version="social-snapshot-v2",
                graph_version="entity-graph-v1.1",
                feature_count=1,
                missing_feature_count=0,
                payload={"mint": mint},
                created_at=NOW,
            )
        )
        session.add(
            IntelligenceSnapshotEntity(
                snapshot_id=snapshot_id,
                entity_key="x_account:alpha",
                entity_type="x_account",
                label="@alpha",
            )
        )
    await session.commit()

    launches = await related_launches(
        session,
        "x_account:alpha",
        exclude_mint=MINT_A,
    )
    assert [item["mint"] for item in launches["launches"]] == [MINT_B]

    result = await execute_research_tools(
        session,
        entity_keys=["x_account:alpha"] * 20,
        current_mint=MINT_A,
        max_entities=8,
    )
    assert result["entities_requested"] == ["x_account:alpha"]
    assert result["tool_calls"] == 2
    assert {item["tool"] for item in result["results"]} == {
        "expand_x_account",
        "related_launches",
    }
