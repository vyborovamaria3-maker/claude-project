from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.models.analytics import Token, Wallet, WalletLink, WalletTrade
from app.services.kol_intelligence import related_wallet_candidates


@pytest.mark.asyncio
async def test_related_wallet_similarity_recomputed_from_unique_trade_tokens(test_app):
    now = datetime.now(timezone.utc)
    async with test_app.state.sessionmaker() as session:
        source = Wallet(wallet_address="source-wallet", first_seen_date=now, tags=[])
        candidate = Wallet(wallet_address="candidate-wallet", first_seen_date=now, tags=[])
        session.add_all([source, candidate])
        await session.flush()

        token_a = Token(mint_address="mint-a", name="A", symbol="A")
        token_b = Token(mint_address="mint-b", name="B", symbol="B")
        token_c = Token(mint_address="mint-c", name="C", symbol="C")
        session.add_all([token_a, token_b, token_c])
        await session.flush()

        session.add_all(
            [
                WalletTrade(
                    wallet_id=source.id,
                    token_id=token_a.id,
                    buy_timestamp=now,
                    amount_buy=1,
                    amount_sold=0,
                    still_holding=True,
                ),
                WalletTrade(
                    wallet_id=source.id,
                    token_id=token_b.id,
                    buy_timestamp=now,
                    amount_buy=1,
                    amount_sold=0,
                    still_holding=True,
                ),
                WalletTrade(
                    wallet_id=candidate.id,
                    token_id=token_a.id,
                    buy_timestamp=now,
                    amount_buy=1,
                    amount_sold=0,
                    still_holding=True,
                ),
                WalletTrade(
                    wallet_id=candidate.id,
                    token_id=token_c.id,
                    buy_timestamp=now,
                    amount_buy=1,
                    amount_sold=0,
                    still_holding=True,
                ),
                # Simulate the legacy ETL inflation bug. KOL intelligence must not
                # expose this stored count/score as the current similarity.
                WalletLink(
                    wallet_a_id=source.id,
                    wallet_b_id=candidate.id,
                    shared_tokens_count=99,
                    first_interaction_date=now,
                    similarity_score=99.0,
                    details={"legacy": True},
                ),
            ]
        )
        await session.commit()

        result = await related_wallet_candidates(session, source.wallet_address, limit=10)

    assert len(result) == 1
    row = result[0]
    assert row["address"] == candidate.wallet_address
    assert row["shared_tokens_count"] == 1
    assert row["similarity_score"] == pytest.approx(1 / 3, abs=1e-6)
    assert 0 <= row["similarity_score"] <= 1
    assert row["ownership_claim"] is False
    assert row["classification"] == "possible_related_wallet"
    assert row["details"]["stored_shared_tokens_count"] == 99
    assert row["details"]["method"] == "jaccard_unique_token_participation"
