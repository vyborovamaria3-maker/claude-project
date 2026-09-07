import asyncio

from app.core.config import Settings
from app.services import solana_funding_verifier


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
    monkeypatch.setattr(
        solana_funding_verifier,
        "_verify_wallet_funding_with_client",
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
