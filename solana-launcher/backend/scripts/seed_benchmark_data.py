from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, insert, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import make_url

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.models.analytics import Token, TokenLatestMetric, TokenMetric, Wallet, WalletTrade

DEFAULT_PREFIX = "bench-token-"
DEFAULT_WALLET = "bench-wallet-hot-path"
SAFE_DATABASE_MARKERS = ("bench", "benchmark", "staging", "stage", "test", "dev")


def _assert_safe_database(args: argparse.Namespace) -> None:
    settings = get_settings()
    environment = settings.environment.strip().lower()
    if environment in {"production", "prod"}:
        raise SystemExit("benchmark seeding is disabled when ENVIRONMENT is production/prod")
    if not args.confirm_benchmark_db:
        raise SystemExit("re-run with --confirm-benchmark-db after verifying DATABASE_URL")

    url = make_url(settings.database_url)
    if not url.drivername.startswith("postgresql"):
        raise SystemExit("benchmark seeding requires a PostgreSQL database")
    database_name = (url.database or "").lower()
    if not any(marker in database_name for marker in SAFE_DATABASE_MARKERS):
        if not args.force_nonstandard_database_name:
            raise SystemExit(
                "database name does not look like a benchmark/staging/test database; "
                "use a safer DATABASE_URL or explicitly pass --force-nonstandard-database-name"
            )


def _token_values(start: int, stop: int, now: datetime, prefix: str) -> list[dict]:
    return [
        {
            "mint_address": f"{prefix}{index:09d}",
            "name": f"Benchmark Token {index}",
            "symbol": f"B{index % 100000:05d}",
            "status": "benchmark",
            "last_synced_at": now,
        }
        for index in range(start, stop)
    ]


async def _seed_tokens(session, *, count: int, batch_size: int, prefix: str) -> int:
    seeded = 0
    now = datetime.now(timezone.utc)
    for start in range(0, count, batch_size):
        stop = min(count, start + batch_size)
        token_values = _token_values(start, stop, now, prefix)
        mints = [row["mint_address"] for row in token_values]
        token_insert = (
            pg_insert(Token)
            .values(token_values)
            .on_conflict_do_nothing(index_elements=[Token.mint_address])
        )
        await session.execute(token_insert)
        token_rows = (
            await session.execute(
                select(Token.id, Token.mint_address).where(Token.mint_address.in_(mints))
            )
        ).all()

        metric_values: list[dict] = []
        metric_payload_by_token: dict[int, dict] = {}
        for token_id, mint in token_rows:
            index = int(str(mint).rsplit("-", 1)[-1])
            price = 0.0001 + (index % 10_000) / 1_000_000
            market_cap = 10_000.0 + float(index % 5_000_000)
            payload = {
                "token_id": int(token_id),
                "timestamp": now,
                "price_usd": price,
                "ath_usd": price * 1.25,
                "market_cap": market_cap,
                "liquidity_usd": 1_000.0 + float(index % 250_000),
                "volume_24h": 500.0 + float((index * 17) % 2_000_000),
                "holder_count": 10 + (index % 100_000),
            }
            metric_values.append(payload)
            metric_payload_by_token[int(token_id)] = payload

        metric_rows = (
            await session.execute(
                insert(TokenMetric)
                .values(metric_values)
                .returning(TokenMetric.id, TokenMetric.token_id)
            )
        ).all()
        latest_values = []
        for metric_id, token_id in metric_rows:
            payload = metric_payload_by_token[int(token_id)]
            latest_values.append(
                {
                    **payload,
                    "metric_id": int(metric_id),
                }
            )

        latest_insert = pg_insert(TokenLatestMetric).values(latest_values)
        excluded = latest_insert.excluded
        await session.execute(
            latest_insert.on_conflict_do_update(
                index_elements=[TokenLatestMetric.token_id],
                set_={
                    "metric_id": excluded.metric_id,
                    "timestamp": excluded.timestamp,
                    "price_usd": excluded.price_usd,
                    "ath_usd": excluded.ath_usd,
                    "market_cap": excluded.market_cap,
                    "liquidity_usd": excluded.liquidity_usd,
                    "volume_24h": excluded.volume_24h,
                    "holder_count": excluded.holder_count,
                },
            )
        )
        await session.commit()
        seeded += len(token_rows)
        print(f"seeded token hot-state: {seeded}/{count}")
    return seeded


async def _seed_wallet_trades(
    session,
    *,
    count: int,
    batch_size: int,
    prefix: str,
    wallet_address: str,
) -> int:
    if count <= 0:
        return 0

    now = datetime.now(timezone.utc)
    wallet_insert = pg_insert(Wallet).values(
        wallet_address=wallet_address,
        tags=["benchmark"],
        created_at=now,
        updated_at=now,
    )
    await session.execute(
        wallet_insert.on_conflict_do_update(
            index_elements=[Wallet.wallet_address],
            set_={"updated_at": now},
        )
    )
    wallet_id = int(
        (
            await session.execute(
                select(Wallet.id).where(Wallet.wallet_address == wallet_address)
            )
        ).scalar_one()
    )
    token_ids = list(
        (
            await session.execute(
                select(Token.id)
                .where(Token.mint_address.like(f"{prefix}%"))
                .order_by(Token.id.asc())
                .limit(10_000)
            )
        ).scalars().all()
    )
    if not token_ids:
        raise RuntimeError("seed benchmark tokens before wallet trades")

    seeded = 0
    for start in range(0, count, batch_size):
        stop = min(count, start + batch_size)
        values = []
        for index in range(start, stop):
            values.append(
                {
                    "wallet_id": wallet_id,
                    "token_id": token_ids[index % len(token_ids)],
                    "buy_timestamp": now - timedelta(seconds=count - index),
                    "sell_timestamp": now - timedelta(seconds=max(0, count - index - 5)),
                    "amount_buy": 1.0,
                    "amount_sold": 1.0,
                    "avg_buy_price": 1.0,
                    "avg_sell_price": 1.0 + ((index % 21) - 10) / 100,
                    "realized_profit_usd": float((index % 21) - 10),
                    "still_holding": False,
                    "extra": {"benchmark": True},
                    "created_at": now,
                }
            )
        await session.execute(insert(WalletTrade).values(values))
        await session.commit()
        seeded += len(values)
        print(f"seeded wallet trades: {seeded}/{count}")
    return seeded


async def _cleanup(session, *, prefix: str, wallet_address: str) -> None:
    await session.execute(delete(Wallet).where(Wallet.wallet_address == wallet_address))
    await session.execute(delete(Token).where(Token.mint_address.like(f"{prefix}%")))
    await session.commit()
    print("benchmark rows removed")


async def _run(args: argparse.Namespace) -> None:
    _assert_safe_database(args)
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    try:
        async with sessionmaker() as session:
            if args.cleanup:
                await _cleanup(
                    session,
                    prefix=args.prefix,
                    wallet_address=args.wallet_address,
                )
                return
            token_count = await _seed_tokens(
                session,
                count=args.tokens,
                batch_size=args.batch_size,
                prefix=args.prefix,
            )
            trade_count = await _seed_wallet_trades(
                session,
                count=args.wallet_trades,
                batch_size=args.batch_size,
                prefix=args.prefix,
                wallet_address=args.wallet_address,
            )
            print(
                f"benchmark seed complete: tokens={token_count}, "
                f"wallet_trades={trade_count}, wallet={args.wallet_address}"
            )
    finally:
        await engine.dispose()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Seed synthetic POTAPoff hot-path data into a non-production PostgreSQL DB.",
    )
    parser.add_argument("--tokens", type=int, default=10_000)
    parser.add_argument("--wallet-trades", type=int, default=0)
    parser.add_argument("--batch-size", type=int, default=5_000)
    parser.add_argument("--prefix", default=DEFAULT_PREFIX)
    parser.add_argument("--wallet-address", default=DEFAULT_WALLET)
    parser.add_argument("--cleanup", action="store_true")
    parser.add_argument("--confirm-benchmark-db", action="store_true")
    parser.add_argument("--force-nonstandard-database-name", action="store_true")
    return parser


def main() -> None:
    args = _parser().parse_args()
    if args.tokens < 1:
        raise SystemExit("--tokens must be >= 1")
    if args.wallet_trades < 0:
        raise SystemExit("--wallet-trades must be >= 0")
    if args.batch_size < 1 or args.batch_size > 5_000:
        raise SystemExit("--batch-size must be between 1 and 5000")
    if not args.prefix.startswith("bench-"):
        raise SystemExit("--prefix must start with 'bench-' so cleanup stays safely scoped")
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
