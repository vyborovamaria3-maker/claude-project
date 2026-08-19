from __future__ import annotations

import asyncio
from typing import Any

import httpx

from app.core.config import Settings

MAX_SIGNATURE_PAGES = 3
SIGNATURE_PAGE_SIZE = 100
MAX_TRANSACTIONS_TO_INSPECT = 40
MAX_TRANSACTION_CONCURRENCY = 6
MAX_WALLET_CONCURRENCY = 2
INITIAL_TRANSACTION_RANK_LIMIT = 10
SYSTEM_PROGRAM_ID = "11111111111111111111111111111111"


async def _rpc(
    client: httpx.AsyncClient,
    url: str,
    method: str,
    params: list[Any],
    request_id: int,
) -> Any:
    response = await client.post(
        url,
        json={
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        },
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("error"):
        raise RuntimeError(str(payload["error"]))
    return payload.get("result")


async def _signatures(
    client: httpx.AsyncClient,
    url: str,
    address: str,
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


async def verify_wallet_funding(
    settings: Settings,
    address: str,
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
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
            signatures, history_exhausted = await _signatures(client, rpc_url, address)
            valid = [row for row in signatures if row.get("signature") and row.get("err") is None]
            oldest_scanned = list(reversed(valid))
            inspect = oldest_scanned[:MAX_TRANSACTIONS_TO_INSPECT]
            semaphore = asyncio.Semaphore(MAX_TRANSACTION_CONCURRENCY)

            async def fetch_transaction(
                index: int,
                signature: str,
            ) -> tuple[int, dict[str, Any] | None]:
                async with semaphore:
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

    async def inspect_wallet(address: str) -> dict[str, Any]:
        async with wallet_semaphore:
            return await verify_wallet_funding(settings, address)

    results = await asyncio.gather(*[inspect_wallet(address) for address in wallets])
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
        "note": ("Same initial funder is a graph clue, not proof of common ownership or control."),
    }
