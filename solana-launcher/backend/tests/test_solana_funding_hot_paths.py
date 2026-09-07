import asyncio

from app.core.config import Settings
from app.services import solana_funding_verifier


class FakeRedis:
    def __init__(self):
        self.data: dict[str, str] = {}

    async def get(self, key: str):
        return self.data.get(key)

    async def set(self, key: str, value: str, *, nx: bool = False, ex=None):
        del ex
        if nx and key in self.data:
            return False
        self.data[key] = value
        return True

    async def delete(self, key: str):
        self.data.pop(key, None)
        return 1

    async def eval(self, script: str, numkeys: int, key: str, token: str):
        del script
        assert numkeys == 1
        if self.data.get(key) == token:
            self.data.pop(key, None)
            return 1
        return 0


async def test_snapshot_wallet_funding_reuses_one_client_and_one_rpc_semaphore(monkeypatch):
    created_clients = 0
    client_ids: set[int] = set()
    semaphore_ids: set[int] = set()
    active_wallets = 0
    max_active_wallets = 0

    class FakeClient:
        def __init__(self, *args, **kwargs):
            nonlocal created_clients
            del args, kwargs
            created_clients += 1

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            del exc_type, exc, tb

    async def fake_verify(settings, address, client, rpc_semaphore):
        nonlocal active_wallets, max_active_wallets
        del settings
        client_ids.add(id(client))
        semaphore_ids.add(id(rpc_semaphore))
        active_wallets += 1
        max_active_wallets = max(max_active_wallets, active_wallets)
        try:
            await asyncio.sleep(0.01)
            return {
                "status": "no_incoming_system_transfer_in_complete_history",
                "wallet": address,
                "incoming_transfer_observed": False,
                "initial_funding_verified": False,
                "transfers": [],
                "history_exhausted": True,
            }
        finally:
            active_wallets -= 1

    monkeypatch.setattr(solana_funding_verifier.httpx, "AsyncClient", FakeClient)
    # This test isolates connection/semaphore behavior; cache semantics are covered
    # separately below.
    monkeypatch.setattr(
        solana_funding_verifier,
        "_cached_verify_wallet_funding_with_client",
        fake_verify,
    )

    wallets = [f"{'A' * 32}{index:02d}" for index in range(8)]
    snapshot = {
        "graph": {
            "nodes": [
                {"type": "wallet", "id": f"wallet:{wallet}", "label": wallet}
                for wallet in wallets
            ]
        }
    }
    settings = Settings(secret_key="b" * 64, environment="test")

    result = await solana_funding_verifier.verify_snapshot_wallet_funding(
        settings,
        snapshot,
        max_wallets=8,
    )

    assert created_clients == 1
    assert len(client_ids) == 1
    assert len(semaphore_ids) == 1
    assert max_active_wallets <= solana_funding_verifier.MAX_WALLET_CONCURRENCY
    assert len(result["wallets"]) == 8


async def test_funding_cache_singleflights_identical_wallet_requests(monkeypatch):
    redis = FakeRedis()
    calls = 0

    async def fake_verify(settings, address, client, rpc_semaphore):
        nonlocal calls
        del settings, client, rpc_semaphore
        calls += 1
        await asyncio.sleep(0.03)
        return {
            "status": "no_verified_funding_edges",
            "wallet": address,
            "incoming_transfer_observed": False,
            "initial_funding_verified": False,
            "transfers": [],
        }

    monkeypatch.setattr(solana_funding_verifier, "get_redis_client", lambda: redis)
    monkeypatch.setattr(
        solana_funding_verifier,
        "_verify_wallet_funding_with_client",
        fake_verify,
    )

    settings = Settings(
        secret_key="b" * 64,
        environment="test",
        helius_rpc_url="https://rpc.example.invalid",
    )
    semaphore = asyncio.Semaphore(8)
    client = object()
    wallet = "A" * 32

    first, second = await asyncio.gather(
        solana_funding_verifier._cached_verify_wallet_funding_with_client(
            settings,
            wallet,
            client,
            semaphore,
        ),
        solana_funding_verifier._cached_verify_wallet_funding_with_client(
            settings,
            wallet,
            client,
            semaphore,
        ),
    )
    third = await solana_funding_verifier._cached_verify_wallet_funding_with_client(
        settings,
        wallet,
        client,
        semaphore,
    )

    assert calls == 1
    assert first == second == third


async def test_funding_lock_release_never_deletes_new_owners_lease() -> None:
    redis = FakeRedis()
    lock_key = "analysis:funding:test:wallet:lock"
    redis.data[lock_key] = "new-owner"

    await solana_funding_verifier._release_funding_lock(
        redis,
        lock_key,
        "expired-old-owner",
    )
    assert redis.data[lock_key] == "new-owner"

    await solana_funding_verifier._release_funding_lock(
        redis,
        lock_key,
        "new-owner",
    )
    assert lock_key not in redis.data


def test_funding_singleflight_wait_covers_bounded_wallet_rpc_worst_case() -> None:
    transaction_waves = (
        solana_funding_verifier.MAX_TRANSACTIONS_TO_INSPECT
        + solana_funding_verifier.MAX_RPC_CONCURRENCY
        - 1
    ) // solana_funding_verifier.MAX_RPC_CONCURRENCY
    bounded_seconds = solana_funding_verifier.RPC_TIMEOUT_SECONDS * (
        solana_funding_verifier.MAX_SIGNATURE_PAGES + transaction_waves
    )

    assert solana_funding_verifier.FUNDING_CACHE_WAIT_SECONDS >= bounded_seconds
    assert (
        solana_funding_verifier.FUNDING_CACHE_LOCK_SECONDS
        > solana_funding_verifier.FUNDING_CACHE_WAIT_SECONDS
    )


async def test_rpc_uses_global_concurrency_limit(monkeypatch):
    active = 0
    max_active = 0

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"jsonrpc": "2.0", "result": {"ok": True}}

        def raise_for_status(self):
            return None

    class FakeClient:
        async def post(self, _url, json):
            nonlocal active, max_active
            del json
            active += 1
            max_active = max(max_active, active)
            try:
                await asyncio.sleep(0.01)
                return FakeResponse()
            finally:
                active -= 1

    # Avoid coupling this concurrency regression test to Prometheus global state.
    monkeypatch.setattr(solana_funding_verifier, "_observe_rpc", lambda *_args, **_kwargs: None)

    semaphore = asyncio.Semaphore(3)
    results = await asyncio.gather(
        *[
            solana_funding_verifier._rpc(
                FakeClient(),
                "https://rpc.invalid",
                "getTransaction",
                [f"signature-{index}"],
                index,
                semaphore,
            )
            for index in range(15)
        ]
    )

    assert max_active == 3
    assert results == [{"ok": True}] * 15
