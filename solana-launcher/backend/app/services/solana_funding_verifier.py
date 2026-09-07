from __future__ import annotations

import asyncio
import hashlib
import json
from time import monotonic
from typing import Any
from uuid import uuid4

import httpx
from redis.exceptions import RedisError

from app.core.config import Settings
from app.services.cache import get_redis_client
from app.services.observability import (
    ANALYSIS_CACHE_REQUESTS,
    PROVIDER_RATE_LIMITS,
    PROVIDER_REQUEST_LATENCY,
    PROVIDER_REQUESTS,
)

MAX_SIGNATURE_PAGES = 3
SIGNATURE_PAGE_SIZE = 100
MAX_TRANSACTIONS_TO_INSPECT = 40
MAX_RPC_CONCURRENCY = 8
MAX_WALLET_CONCURRENCY = 4
INITIAL_TRANSACTION_RANK_LIMIT = 10
RPC_TIMEOUT_SECONDS = 8.0
FUNDING_CACHE_TTL_SECONDS = 90
# One uncached wallet can require 3 sequential signature pages plus five
# getTransaction waves at MAX_RPC_CONCURRENCY. Keep the ownership lease beyond
# that bounded single-wallet worst case and let followers wait long enough for it.
FUNDING_CACHE_LOCK_SECONDS = 90
FUNDING_CACHE_WAIT_SECONDS = 70.0
SYSTEM_PROGRAM_ID = "11111111111111111111111111111111"
_RELEASE_LOCK_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
"""


def _observe_rpc(method: str, result: str, elapsed: float) -> None:
    PROVIDER_REQUESTS.labels(
        provider="solana_rpc",
        operation=method,
        result=result,
    ).inc()
    PROVIDER_REQUEST_LATENCY.labels(
        provider="solana_rpc",
        operation=method,
    ).observe(elapsed)


def _funding_cache_key(rpc_url: str, address: str) -> str:
    provider = hashlib.sha256(rpc_url.encode("utf-8")).hexdigest()[:12]
    return f"analysis:funding:{provider}:{address}"


async def _release_funding_lock(redis, lock_key: str, token: str) -> None:
    """Release only the lease owned by token, atomically inside Redis."""
    try:
        await redis.eval(_RELEASE_LOCK_SCRIPT, 1, lock_key, token)
    except RedisError:
        # Cache coordination is best-effort; evidence collection must not fail
        # solely because Redis became unavailable while releasing a lease.
        return


async def _rpc(
    client: httpx.AsyncClient,
    url: str,
    method: str,
    params: list[Any],
    request_id: int,
    semaphore: asyncio.Semaphore | None = None,
) -> Any:
    started = monotonic()
    try:
        if semaphore is None:
            response = await client.post(
                url,
                json={
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": method,
                    "params": params,
                },
            )
        else:
            async with semaphore:
                response = await client.post(
                    url,
                    json={
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "method": method,
                        "params": params,
                    },
                )
    except httpx.HTTPError:
        _observe_rpc(method, "transport_error", monotonic() - started)
        raise

    status_code = int(response.status_code)
    if status_code == 429:
        PROVIDER_RATE_LIMITS.labels(
            provider="solana_rpc",
            operation=method,
        ).inc()
    if status_code >= 400:
        _observe_rpc(method, f"http_{status_code}", monotonic() - started)
        response.raise_for_status()

    payload = response.json()
    if payload.get("error"):
        _observe_rpc(method, "rpc_error", monotonic() - started)
        raise RuntimeError(str(payload["error"]))
    _observe_rpc(method, "ok", monotonic() - started)
    return payload.get("result")


async def _signatures(
    client: httpx.AsyncClient,
    url: str,
    address: str,
    semaphore: asyncio.Semaphore | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    rows: list[dict[str, Any]] = []
    before: str | None = None
    exhausted = False
    for page in range(MAX_SIGNATURE_PAGES):
        options: dict[str, Any] = {
            "limit": SIGNATURE_PAGE_SIZE,
            "commitment": "confirmed",
        }
        if before:
            options["before"] = before
        result = await _rpc(
            client,
            url,
            "getSignaturesForAddress",
            [address, options],
            page + 1,
            semaphore,
        )
        batch = result if isinstance(result, list) else []
        rows.extend(row for row in batch if isinstance(row, dict))
        if len(batch) < SIGNATURE_PAGE_SIZE:
            exhausted = True
            break
        before = str(batch[-1].get("signature") or "") or None
        if not before:
            exhausted = True
            break
    return rows, exhausted


def _incoming_system_transfers(
    transaction: dict[str, Any] | None,
    address: str,
    *,
    inspected_rank: int,
) -> list[dict[str, Any]]:
    if not isinstance(transaction, dict):
        return []
    block_time = transaction.get("blockTime")
    tx = transaction.get("transaction") or {}
    message = tx.get("message") or {}
    instructions = message.get("instructions") or []
    signatures = tx.get("signatures") or []
    signature = signatures[0] if signatures else None
    transfers: list[dict[str, Any]] = []

    for instruction in instructions:
        if not isinstance(instruction, dict):
            continue
        program = str(instruction.get("program") or "").lower()
        program_id = str(instruction.get("programId") or "")
        if program != "system" and program_id != SYSTEM_PROGRAM_ID:
            continue
        parsed = instruction.get("parsed")
        if not isinstance(parsed, dict):
            continue
        if parsed.get("type") not in {"transfer", "transferWithSeed"}:
            continue
        info = parsed.get("info") or {}
        if str(info.get("destination") or "") != address:
            continue
        try:
            lamports_value = int(info["lamports"])
        except (KeyError, TypeError, ValueError):
            continue
        if lamports_value <= 0:
            continue
        source = str(info.get("source") or "") or None
        if not source:
            continue
        transfers.append(
            {
                "source": source,
                "destination": address,
                "lamports": lamports_value,
                "sol": lamports_value / 1_000_000_000,
                "signature": signature,
                "block_time": block_time,
                "program": "system",
                "program_id": SYSTEM_PROGRAM_ID,
                "inspected_rank_from_oldest": inspected_rank,
            }
        )
    return transfers


async def _verify_wallet_funding_with_client(
    settings: Settings,
    address: str,
    client: httpx.AsyncClient,
    rpc_semaphore: asyncio.Semaphore,
) -> dict[str, Any]:
    rpc_url = (settings.helius_rpc_url or settings.solana_rpc_url or "").strip()
    if not rpc_url:
        return {
            "status": "rpc_unavailable",
            "wallet": address,
            "incoming_transfer_observed": False,
            "initial_funding_verified": False,
            "transfers": [],
        }
    try:
        signatures, history_exhausted = await _signatures(
            client,
            rpc_url,
            address,
            rpc_semaphore,
        )
        valid = [
            row
            for row in signatures
            if row.get("signature") and row.get("err") is None
        ]
        oldest_scanned = list(reversed(valid))
        inspect = oldest_scanned[:MAX_TRANSACTIONS_TO_INSPECT]

        async def fetch_transaction(
            index: int,
            signature: str,
        ) -> tuple[int, dict[str, Any] | None]:
            try:
                value = await _rpc(
                    client,
                    rpc_url,
                    "getTransaction",
                    [
                        signature,
                        {
                            "encoding": "jsonParsed",
                            "commitment": "confirmed",
                            "maxSupportedTransactionVersion": 0,
                        },
                    ],
                    10_000 + index,
                    rpc_semaphore,
                )
                return index, value if isinstance(value, dict) else None
            except (httpx.HTTPError, RuntimeError):
                return index, None

        fetched = await asyncio.gather(
            *[
                fetch_transaction(index, str(row["signature"]))
                for index, row in enumerate(inspect)
            ]
        )

        transfers: list[dict[str, Any]] = []
        for index, transaction in sorted(fetched):
            transfers.extend(
                _incoming_system_transfers(
                    transaction,
                    address,
                    inspected_rank=index + 1,
                )
            )
        transfers.sort(
            key=lambda row: (
                row.get("inspected_rank_from_oldest") or 10**9,
                row.get("block_time") is None,
                row.get("block_time") or 0,
            )
        )
        first_observed = transfers[0] if transfers else None
        initial_funding = None
        if history_exhausted:
            initial_funding = next(
                (
                    row
                    for row in transfers
                    if int(row.get("inspected_rank_from_oldest") or 10**9)
                    <= INITIAL_TRANSACTION_RANK_LIMIT
                ),
                None,
            )

        if initial_funding:
            status = "initial_funding_verified"
        elif first_observed:
            status = (
                "incoming_transfer_observed_not_initial"
                if history_exhausted
                else "incoming_transfer_observed_partial_history"
            )
        elif history_exhausted:
            status = "no_incoming_system_transfer_in_complete_history"
        else:
            status = "no_incoming_system_transfer_in_scanned_history"

        return {
            "status": status,
            "wallet": address,
            "incoming_transfer_observed": bool(first_observed),
            "initial_funding_verified": bool(initial_funding),
            "first_observed_incoming_transfer": first_observed,
            "initial_funding_transfer": initial_funding,
            "transfers": transfers[:20],
            "signatures_scanned": len(valid),
            "transactions_inspected": len(inspect),
            "history_exhausted": history_exhausted,
            "search_complete": history_exhausted,
            "initial_rank_limit": INITIAL_TRANSACTION_RANK_LIMIT,
            "note": (
                "A positive System Program transfer proves an incoming SOL transfer. "
                "It is labeled initial funding only when full address history was "
                "exhausted and the transfer occurred among the earliest inspected "
                "transactions. Neither condition proves common ownership."
            ),
        }
    except (httpx.HTTPError, RuntimeError) as exc:
        return {
            "status": "rpc_error",
            "wallet": address,
            "incoming_transfer_observed": False,
            "initial_funding_verified": False,
            "transfers": [],
            "error": str(exc)[:500],
        }


async def _cached_verify_wallet_funding_with_client(
    settings: Settings,
    address: str,
    client: httpx.AsyncClient,
    rpc_semaphore: asyncio.Semaphore,
) -> dict[str, Any]:
    rpc_url = (settings.helius_rpc_url or settings.solana_rpc_url or "").strip()
    if not rpc_url:
        return await _verify_wallet_funding_with_client(
            settings,
            address,
            client,
            rpc_semaphore,
        )

    redis = get_redis_client()
    cache_key = _funding_cache_key(rpc_url, address)
    lock_key = f"{cache_key}:lock"
    try:
        raw = await redis.get(cache_key)
        if raw:
            ANALYSIS_CACHE_REQUESTS.labels(layer="wallet_funding", result="hit").inc()
            cached = json.loads(raw)
            if isinstance(cached, dict):
                return cached
        ANALYSIS_CACHE_REQUESTS.labels(layer="wallet_funding", result="miss").inc()
    except (RedisError, json.JSONDecodeError):
        ANALYSIS_CACHE_REQUESTS.labels(layer="wallet_funding", result="bypass").inc()
        return await _verify_wallet_funding_with_client(
            settings,
            address,
            client,
            rpc_semaphore,
        )

    token = uuid4().hex
    try:
        acquired = bool(
            await redis.set(
                lock_key,
                token,
                nx=True,
                ex=FUNDING_CACHE_LOCK_SECONDS,
            )
        )
    except RedisError:
        acquired = False

    if not acquired:
        deadline = monotonic() + FUNDING_CACHE_WAIT_SECONDS
        while monotonic() < deadline:
            await asyncio.sleep(0.15)
            try:
                raw = await redis.get(cache_key)
            except RedisError:
                break
            if raw:
                try:
                    cached = json.loads(raw)
                except json.JSONDecodeError:
                    break
                if isinstance(cached, dict):
                    ANALYSIS_CACHE_REQUESTS.labels(
                        layer="wallet_funding",
                        result="wait_hit",
                    ).inc()
                    return cached
        ANALYSIS_CACHE_REQUESTS.labels(
            layer="wallet_funding",
            result="wait_timeout",
        ).inc()
        return await _verify_wallet_funding_with_client(
            settings,
            address,
            client,
            rpc_semaphore,
        )

    try:
        result = await _verify_wallet_funding_with_client(
            settings,
            address,
            client,
            rpc_semaphore,
        )
        try:
            await redis.set(
                cache_key,
                json.dumps(result, default=str),
                ex=FUNDING_CACHE_TTL_SECONDS,
            )
        except RedisError:
            pass
        return result
    finally:
        await _release_funding_lock(redis, lock_key, token)


async def verify_wallet_funding(
    settings: Settings,
    address: str,
) -> dict[str, Any]:
    """Verify one wallet using a bounded connection pool and short-lived cache."""
    limits = httpx.Limits(
        max_connections=MAX_RPC_CONCURRENCY,
        max_keepalive_connections=MAX_RPC_CONCURRENCY,
    )
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(RPC_TIMEOUT_SECONDS),
        limits=limits,
    ) as client:
        return await _cached_verify_wallet_funding_with_client(
            settings,
            address,
            client,
            asyncio.Semaphore(MAX_RPC_CONCURRENCY),
        )


async def verify_snapshot_wallet_funding(
    settings: Settings,
    snapshot: dict[str, Any],
    *,
    max_wallets: int = 8,
) -> dict[str, Any]:
    graph = snapshot.get("graph") or {}
    nodes = graph.get("nodes") or []
    wallets: list[str] = []
    for node in nodes:
        if not isinstance(node, dict) or node.get("type") != "wallet":
            continue
        label = str(node.get("label") or "").strip()
        node_id = str(node.get("id") or "")
        address = label if 32 <= len(label) <= 44 else node_id.removeprefix("wallet:")
        if 32 <= len(address) <= 44:
            wallets.append(address)
    wallets = list(dict.fromkeys(wallets))[:max_wallets]
    if not wallets:
        return {
            "status": "no_wallets",
            "wallets": [],
            "initial_funding_edges": [],
            "observed_incoming_transfers": [],
            "same_funder_groups": [],
        }

    wallet_semaphore = asyncio.Semaphore(MAX_WALLET_CONCURRENCY)
    rpc_semaphore = asyncio.Semaphore(MAX_RPC_CONCURRENCY)
    limits = httpx.Limits(
        max_connections=MAX_RPC_CONCURRENCY,
        max_keepalive_connections=MAX_RPC_CONCURRENCY,
    )

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(RPC_TIMEOUT_SECONDS),
        limits=limits,
    ) as client:

        async def inspect_wallet(address: str) -> dict[str, Any]:
            async with wallet_semaphore:
                return await _cached_verify_wallet_funding_with_client(
                    settings,
                    address,
                    client,
                    rpc_semaphore,
                )

        results = await asyncio.gather(
            *[inspect_wallet(address) for address in wallets]
        )

    initial_funders: dict[str, list[str]] = {}
    initial_edges: list[dict[str, Any]] = []
    observed_transfers: list[dict[str, Any]] = []

    for result in results:
        wallet = str(result.get("wallet") or "")
        observed = result.get("first_observed_incoming_transfer")
        if wallet and isinstance(observed, dict):
            observed_transfers.append(
                {
                    "source": observed.get("source"),
                    "target": wallet,
                    "type": "INCOMING_SOL_TRANSFER",
                    "signature": observed.get("signature"),
                    "lamports": observed.get("lamports"),
                    "block_time": observed.get("block_time"),
                    "history_complete": bool(result.get("history_exhausted")),
                    "confidence": 1.0,
                    "ownership_inference_allowed": False,
                }
            )

        transfer = result.get("initial_funding_transfer")
        if not result.get("initial_funding_verified") or not isinstance(transfer, dict):
            continue
        source = str(transfer.get("source") or "")
        if not source or not wallet:
            continue
        initial_funders.setdefault(source, []).append(wallet)
        initial_edges.append(
            {
                "source": source,
                "target": wallet,
                "type": "INITIAL_FUNDED_BY",
                "signature": transfer.get("signature"),
                "lamports": transfer.get("lamports"),
                "block_time": transfer.get("block_time"),
                "history_complete": True,
                "confidence": 0.95,
                "ownership_inference_allowed": False,
            }
        )

    same_funder = [
        {
            "funder": funder,
            "wallets": sorted(set(members)),
            "relationship": "SAME_INITIAL_FUNDER",
            "confidence": 0.90,
            "ownership_inference_allowed": False,
        }
        for funder, members in initial_funders.items()
        if len(set(members)) >= 2
    ]

    return {
        "status": (
            "initial_funding_verified"
            if initial_edges
            else "incoming_transfers_only"
            if observed_transfers
            else "no_verified_funding_edges"
        ),
        "wallets": results,
        "initial_funding_edges": initial_edges,
        "observed_incoming_transfers": observed_transfers,
        "same_funder_groups": same_funder,
        "note": (
            "Same initial funder is a graph clue, not proof of common ownership or control."
        ),
    }
