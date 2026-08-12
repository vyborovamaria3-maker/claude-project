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
            "verified": False,
            "transfers": [],
        }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
            signatures, history_exhausted = await _signatures(client, rpc_url, address)
            valid = [
                row
                for row in signatures
                if row.get("signature") and row.get("err") is None
            ]
            inspect = list(reversed(valid))[:MAX_TRANSACTIONS_TO_INSPECT]
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
        for _, transaction in sorted(fetched):
            transfers.extend(_incoming_system_transfers(transaction, address))
        transfers.sort(
            key=lambda row: (
                row.get("block_time") is None,
                row.get("block_time") or 0,
            )
        )
        first = transfers[0] if transfers else None
        return {
            "status": "verified" if first else "no_incoming_system_transfer_found",
            "wallet": address,
            "verified": bool(first),
            "first_incoming_transfer": first,
            "transfers": transfers[:20],
            "signatures_scanned": len(valid),
            "transactions_inspected": len(inspect),
            "history_exhausted": history_exhausted,
            "search_complete": history_exhausted,
            "note": (
                "Funding evidence requires a parsed positive-lamport System Program "
                "transfer to the wallet. SPL token transfers are excluded."
            ),
        }
    except (httpx.HTTPError, RuntimeError) as exc:
        return {
            "status": "rpc_error",
            "wallet": address,
            "verified": False,
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
            "verified_edges": [],
            "same_funder_groups": [],
        }

    wallet_semaphore = asyncio.Semaphore(MAX_WALLET_CONCURRENCY)

    async def inspect_wallet(address: str) -> dict[str, Any]:
        async with wallet_semaphore:
            return await verify_wallet_funding(settings, address)

    results = await asyncio.gather(*[inspect_wallet(address) for address in wallets])
    funders: dict[str, list[str]] = {}
    verified_edges: list[dict[str, Any]] = []
    for result in results:
        transfer = result.get("first_incoming_transfer")
        if not result.get("verified") or not isinstance(transfer, dict):
            continue
        source = str(transfer.get("source") or "")
        wallet = str(result.get("wallet") or "")
        if not source or not wallet:
            continue
        funders.setdefault(source, []).append(wallet)
        verified_edges.append(
            {
                "source": source,
                "target": wallet,
                "type": "FUNDED_BY",
                "signature": transfer.get("signature"),
                "lamports": transfer.get("lamports"),
                "block_time": transfer.get("block_time"),
                "confidence": 1.0,
            }
        )
    same_funder = [
        {
            "funder": funder,
            "wallets": sorted(set(members)),
            "confidence": 1.0,
        }
        for funder, members in funders.items()
        if len(set(members)) >= 2
    ]
    return {
        "status": "verified" if verified_edges else "no_verified_funding_edges",
        "wallets": results,
        "verified_edges": verified_edges,
        "same_funder_groups": same_funder,
    }
