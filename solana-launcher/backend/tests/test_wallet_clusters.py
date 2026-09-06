from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from app.models.analytics import Token, Wallet, WalletLink, WalletTrade
from app.services.wallet_clusters import rebuild_wallet_links


async def test_wallet_cluster_rebuild_is_idempotent_and_deduplicates_trades(test_app):
    now = datetime(2026, 9, 6, tzinfo=timezone.utc)
    async with test_app.state.sessionmaker() as session:
        tokens = [Token(mint_address=f"cluster-token-{index}") for index in range(3)]
        wallet_a = Wallet(wallet_address="cluster-wallet-a")
        wallet_b = Wallet(wallet_address="cluster-wallet-b")
        wallet_c = Wallet(wallet_address="cluster-wallet-c")
        session.add_all([*tokens, wallet_a, wallet_b, wallet_c])
        await session.flush()

        trades = []
        for index, token in enumerate(tokens):
            trades.extend(
                [
                    WalletTrade(
                        wallet_id=wallet_a.id,
                        token_id=token.id,
                        buy_timestamp=now + timedelta(minutes=index),
                        amount_buy=1.0,
                        amount_sold=0.0,
                    ),
                    WalletTrade(
                        wallet_id=wallet_b.id,
                        token_id=token.id,
                        buy_timestamp=now + timedelta(minutes=index + 1),
                        amount_buy=1.0,
                        amount_sold=0.0,
                    ),
                ]
            )

        # A duplicate trade for the same wallet/token must not inflate shared-token count.
        trades.append(
            WalletTrade(
                wallet_id=wallet_a.id,
                token_id=tokens[0].id,
                buy_timestamp=now + timedelta(minutes=10),
                amount_buy=2.0,
                amount_sold=0.0,
            )
        )

        # Wallet C overlaps with only two tokens, below the materialization threshold.
        for index, token in enumerate(tokens[:2]):
            trades.append(
                WalletTrade(
                    wallet_id=wallet_c.id,
                    token_id=token.id,
                    buy_timestamp=now + timedelta(minutes=index + 2),
                    amount_buy=1.0,
                    amount_sold=0.0,
                )
            )

        session.add_all(trades)
        await session.commit()

        first_count = await rebuild_wallet_links(session)
        await session.commit()
        second_count = await rebuild_wallet_links(session)
        await session.commit()

        rows = list((await session.execute(select(WalletLink))).scalars().all())
        total = int(await session.scalar(select(func.count()).select_from(WalletLink)) or 0)

    assert first_count == 1
    assert second_count == 1
    assert total == 1
    assert len(rows) == 1
    assert rows[0].wallet_a_id == wallet_a.id
    assert rows[0].wallet_b_id == wallet_b.id
    assert rows[0].shared_tokens_count == 3
    assert rows[0].similarity_score == 3.0
