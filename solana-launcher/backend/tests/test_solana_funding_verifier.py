from app.services.solana_funding_verifier import _incoming_system_transfers

WALLET = "11111111111111111111111111111112"
SOURCE = "11111111111111111111111111111113"


def _transaction(instruction: dict) -> dict:
    return {
        "blockTime": 123,
        "transaction": {
            "signatures": ["sig-1"],
            "message": {"instructions": [instruction]},
        },
    }


def test_spl_transfer_is_not_treated_as_sol_funding() -> None:
    transaction = _transaction(
        {
            "program": "spl-token",
            "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            "parsed": {
                "type": "transfer",
                "info": {
                    "source": SOURCE,
                    "destination": WALLET,
                    "amount": "1000000000",
                },
            },
        }
    )
    assert _incoming_system_transfers(transaction, WALLET, inspected_rank=1) == []


def test_positive_system_lamport_transfer_is_funding_evidence() -> None:
    transaction = _transaction(
        {
            "program": "system",
            "programId": "11111111111111111111111111111111",
            "parsed": {
                "type": "transfer",
                "info": {
                    "source": SOURCE,
                    "destination": WALLET,
                    "lamports": 1_500_000_000,
                },
            },
        }
    )
    rows = _incoming_system_transfers(transaction, WALLET, inspected_rank=1)
    assert len(rows) == 1
    assert rows[0]["source"] == SOURCE
    assert rows[0]["lamports"] == 1_500_000_000
    assert rows[0]["sol"] == 1.5
    assert rows[0]["program"] == "system"
    assert rows[0]["inspected_rank_from_oldest"] == 1


def test_zero_or_missing_lamports_are_rejected() -> None:
    zero = _transaction(
        {
            "program": "system",
            "parsed": {
                "type": "transfer",
                "info": {
                    "source": SOURCE,
                    "destination": WALLET,
                    "lamports": 0,
                },
            },
        }
    )
    missing = _transaction(
        {
            "program": "system",
            "parsed": {
                "type": "transfer",
                "info": {"source": SOURCE, "destination": WALLET},
            },
        }
    )
    assert _incoming_system_transfers(zero, WALLET, inspected_rank=1) == []
    assert _incoming_system_transfers(missing, WALLET, inspected_rank=1) == []
