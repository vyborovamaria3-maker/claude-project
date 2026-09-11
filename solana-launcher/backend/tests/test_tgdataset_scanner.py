from __future__ import annotations

import io
import json
import tarfile

from app.services.tgdataset_scanner import (
    TGDatasetChannelAccumulator,
    build_outputs,
    iter_tgdataset_channels,
    scan_tar_stream,
    zenodo_archive_url,
)


ADDR_1 = "3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump"
ADDR_2 = "DksAcB4w38E7bfzQ2KbjwG3sf95vUPWX9x7rhniwpump"


def _dataset_bytes() -> bytes:
    payload = {
        "1001": {
            "creation_date": 1,
            "username": "solana_calls",
            "title": "Solana Meme Calls",
            "description": "Solana memecoin alpha and gems",
            "scam": False,
            "verified": False,
            "n_subscribers": 12345,
            "text_messages": {
                "1": {
                    "message": f"New Solana gem CA {ADDR_1} entry now",
                    "date": 1,
                    "author": 1001,
                    "is_forwarded": False,
                },
                "2": {
                    "message": f"Another memecoin call CA {ADDR_2} 10x setup",
                    "date": 2,
                    "author": 1001,
                    "is_forwarded": True,
                },
            },
            "generic_media": {},
        },
        "1002": {
            "creation_date": 1,
            "username": "gaming_mods",
            "title": "Game Modding",
            "description": "Mods and maps",
            "scam": False,
            "verified": False,
            "n_subscribers": 5000,
            "text_messages": {
                "1": {
                    "message": "New texture pack released today",
                    "date": 1,
                    "author": 1002,
                    "is_forwarded": False,
                }
            },
            "generic_media": {},
        },
        "1003": {
            "creation_date": 1,
            "username": "eth_meme_gems",
            "title": "ETH Meme Gems",
            "description": "Ethereum memecoin calls",
            "scam": False,
            "verified": False,
            "n_subscribers": 8000,
            "text_messages": {
                "1": {
                    "message": "Meme gem contract 0x1111111111111111111111111111111111111111 buy entry",
                    "date": 1,
                    "author": 1003,
                    "is_forwarded": False,
                }
            },
            "generic_media": {},
        },
    }
    return json.dumps(payload).encode("utf-8")


def _tar_bytes() -> bytes:
    data = _dataset_bytes()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        info = tarfile.TarInfo("TGDataset_1/channels_000.json")
        info.size = len(data)
        archive.addfile(info, io.BytesIO(data))
    return output.getvalue()


def test_streaming_json_classifies_crypto_without_loading_archive() -> None:
    rows = list(iter_tgdataset_channels(io.BytesIO(_dataset_bytes())))
    by_username = {row["username"]: row for row in rows}

    solana = by_username["solana_calls"]
    assert "crypto" in solana["classifications"]
    assert "memecoin" in solana["classifications"]
    assert "solana" in solana["classifications"]
    assert "caller" in solana["classifications"]
    assert solana["signals"]["unique_solana_mints"] == 2
    assert solana["signals"]["forwarded_messages"] == 1

    assert by_username["gaming_mods"]["classifications"] == []
    assert "memecoin" in by_username["eth_meme_gems"]["classifications"]
    assert by_username["eth_meme_gems"]["signals"]["unique_evm_contracts"] == 1


def test_ca_only_solana_message_survives_fast_gate() -> None:
    channel = TGDatasetChannelAccumulator(channel_id="1004", username="raw_mints")
    channel.observe_message(ADDR_2)
    result = channel.result()

    assert result["signals"]["signal_messages"] == 1
    assert result["signals"]["contract_messages"] == 1
    assert result["signals"]["solana_messages"] == 1
    assert result["signals"]["unique_solana_mints"] == 1
    assert "solana" in result["classifications"]


def test_tar_stream_emits_only_candidates() -> None:
    emitted = []
    stats = scan_tar_stream(
        io.BytesIO(_tar_bytes()),
        archive_name="TGDataset_1.tar.gz",
        on_candidate=emitted.append,
    )
    assert stats.json_members == 1
    assert stats.channels_scanned == 3
    assert stats.candidates == 2
    assert {row["username"] for row in emitted} == {"solana_calls", "eth_meme_gems"}


def test_build_outputs_creates_small_seed_database(tmp_path) -> None:
    rows = list(iter_tgdataset_channels(io.BytesIO(_dataset_bytes())))
    candidate_path = tmp_path / "TGDataset_1.tar.gz.candidates.jsonl"
    with candidate_path.open("w", encoding="utf-8") as handle:
        for row in rows:
            if row["classifications"]:
                handle.write(json.dumps(row) + "\n")

    summary = build_outputs(tmp_path, seed_limit=10)
    payload = json.loads((tmp_path / "telegram_seed_database.json").read_text(encoding="utf-8"))
    usernames = {row["username"] for row in payload["channels"]}
    assert summary["candidate_channels"] == 2
    assert "solana_calls" in usernames
    assert "gaming_mods" not in usernames


def test_seed_scoring_does_not_treat_stock_ticker_alone_as_crypto() -> None:
    channel = TGDatasetChannelAccumulator(channel_id="7", username="stocks")
    channel.observe_message("$AAPL buy entry")
    result = channel.result()
    assert result["classifications"] == []


def test_contract_bonus_requires_memecoin_context() -> None:
    generic = TGDatasetChannelAccumulator(
        channel_id="8",
        username="contract_tracker",
        title="Crypto Contract Tracker",
    )
    generic.observe_message(f"Contract {ADDR_1} entry")

    memecoin = TGDatasetChannelAccumulator(
        channel_id="9",
        username="meme_calls",
        title="Meme Coin Calls",
    )
    memecoin.observe_message(f"Contract {ADDR_1} entry")

    generic_result = generic.result()
    memecoin_result = memecoin.result()
    assert "memecoin" not in generic_result["classifications"]
    assert "memecoin" in memecoin_result["classifications"]
    assert memecoin_result["scores"]["memecoin"] > generic_result["scores"]["memecoin"]


def test_zenodo_url_targets_original_archive() -> None:
    url = zenodo_archive_url("TGDataset_4.tar.gz")
    assert "zenodo.org/records/7640712/files/TGDataset_4.tar.gz" in url


def test_native_solana_target_matching_regressions() -> None:
    solscan = TGDatasetChannelAccumulator(channel_id="solscan")
    solscan.observe_message("https://solscan.io/")
    solscan_result = solscan.result()

    assert solscan_result["signals"]["signal_messages"] == 1
    assert solscan_result["signals"]["solana_messages"] == 1

    pumpfun = TGDatasetChannelAccumulator(channel_id="pumpfun")
    pumpfun.observe_message(
        "https://pump.fun/coin/DaEUPVqGjt3SKEREJaHCgKtkjiTPJNYAhuyKEXZ6pump"
    )
    pumpfun_result = pumpfun.result()

    assert pumpfun_result["signals"]["pumpfun_messages"] == 1
    assert pumpfun_result["signals"]["solana_messages"] == 1
    assert pumpfun_result["signals"]["unique_solana_mints"] == 1

    sol_ticker = TGDatasetChannelAccumulator(channel_id="sol-ticker")
    sol_ticker.observe_message("$SOL breakout")
    sol_result = sol_ticker.result()

    assert sol_result["signals"]["solana_messages"] == 1

    plural_meme = TGDatasetChannelAccumulator(channel_id="memecoins")
    plural_meme.observe_message("#memecoins")
    plural_meme_result = plural_meme.result()

    assert plural_meme_result["signals"]["memecoin_messages"] == 1


def test_ambiguous_terms_do_not_create_solana_target() -> None:
    samples = (
        "Jupiter is the largest planet in the solar system",
        "The photographer uses a Photon camera",
        "I use the Phantom browser extension",
        "BullX is just a word here",
        "GMGN",
        "https://dexscreener.com/",
    )

    for index, sample in enumerate(samples):
        acc = TGDatasetChannelAccumulator(channel_id=f"ambiguous-{index}")
        acc.observe_message(sample)
        result = acc.result()

        assert result["signals"]["solana_messages"] == 0
        assert "solana" not in result["classifications"]


def test_bonkers_is_not_bonk_memecoin_signal() -> None:
    acc = TGDatasetChannelAccumulator(channel_id="bonkers")
    acc.observe_message("That plan is completely bonkers")
    result = acc.result()

    assert result["signals"]["memecoin_messages"] == 0
    assert result["signals"]["signal_messages"] == 0
