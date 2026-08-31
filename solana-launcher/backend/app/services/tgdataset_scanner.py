from __future__ import annotations

import json
import math
import re
import tarfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterable, Iterator
from urllib.request import Request, urlopen

from app.services.telegram_parser import parse_telegram_message


ZENODO_RECORD_ID = 7640712
ZENODO_ARCHIVES = (
    "TGDataset_1.tar.gz",
    "TGDataset_2.tar.gz",
    "TGDataset_3.tar.gz",
    "TGDataset_4.tar.gz",
)
_ZENODO_URL = "https://zenodo.org/records/{record_id}/files/{filename}?download=1"
_USER_AGENT = "POTAPoff-TGDataset-Scanner/1.0"
_MAX_UNIQUE_CONTRACTS = 20_000

_EVM_CONTRACT_RE = re.compile(r"(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])")
_CRYPTO_RE = re.compile(
    r"\b(?:crypto(?:currency)?|bitcoin|btc|ethereum|ether|eth|blockchain|web3|defi|dex|cex|"
    r"binance|bnb|altcoin|airdrop|token|coin|metamask|uniswap|pancakeswap|nft|staking|"
    r"liquidity|presale|ido|ico|solana|raydium|jupiter)\b",
    re.IGNORECASE,
)
_MEME_RE = re.compile(
    r"\b(?:memecoin|meme\s*coin|meme\s*token|dogecoin|doge|shiba|shib|floki|babydoge|"
    r"baby\s*doge|safemoon|pepe|bonk|dogwifhat|\$wif|shitcoin|degen|community\s*token)\b",
    re.IGNORECASE,
)
_SOLANA_RE = re.compile(
    r"\b(?:solana|\$sol|raydium|jupiter|orca|serum|phantom|solscan|spl\s*token|pump\.fun|pumpfun)\b",
    re.IGNORECASE,
)
_CALL_RE = re.compile(
    r"\b(?:call|calling|caller|gem|alpha|ape|aping|entry|buy|send(?:ing)?|moon|moonshot|"
    r"100x|50x|20x|10x|cto|stealth|launch|presale|fair\s*launch|market\s*cap|mcap|contract|ca)\b",
    re.IGNORECASE,
)
_PUMPFUN_RE = re.compile(r"(?:pump\.fun|pumpfun)", re.IGNORECASE)
_GATE_RE = re.compile(
    r"(?:crypto|bitcoin|\bbtc\b|ethereum|\beth\b|blockchain|web3|defi|dex|binance|\bbnb\b|"
    r"altcoin|airdrop|token|coin|meme|doge|shib|floki|safemoon|pepe|bonk|solana|raydium|"
    r"jupiter|pump\.fun|pumpfun|0x[0-9a-fA-F]{40}|\$[A-Za-z][A-Za-z0-9_]{1,11}|"
    r"\b(?:contract|ca|mcap|gem|presale|launch|100x|50x|20x|10x)\b)",
    re.IGNORECASE,
)


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def zenodo_archive_url(filename: str, *, record_id: int = ZENODO_RECORD_ID) -> str:
    if filename not in ZENODO_ARCHIVES:
        raise ValueError(f"Unknown TGDataset archive: {filename}")
    return _ZENODO_URL.format(record_id=record_id, filename=filename)


def _scaled_count(count: int, target: int, points: float) -> float:
    if count <= 0:
        return 0.0
    return points * min(1.0, math.log1p(count) / math.log1p(target))


def _density(count: int, total: int, points: float) -> float:
    if count <= 0 or total <= 0:
        return 0.0
    return min(points, (count / total) * points)


@dataclass(slots=True)
class TGDatasetChannelAccumulator:
    channel_id: str
    username: str = ""
    title: str = ""
    description: str = ""
    scam: bool = False
    verified: bool = False
    n_subscribers: int = 0
    messages_total: int = 0
    signal_messages: int = 0
    crypto_messages: int = 0
    memecoin_messages: int = 0
    solana_messages: int = 0
    contract_messages: int = 0
    explicit_call_messages: int = 0
    ticker_messages: int = 0
    pumpfun_messages: int = 0
    forwarded_messages: int = 0
    telegram_links: int = 0
    metadata_crypto: bool = False
    metadata_memecoin: bool = False
    metadata_solana: bool = False
    metadata_caller: bool = False
    _solana_mints: set[str] = field(default_factory=set)
    _evm_contracts: set[str] = field(default_factory=set)

    def observe_metadata(self, field_name: str, value: Any) -> None:
        if field_name == "username" and isinstance(value, str):
            self.username = value.strip().lstrip("@")
        elif field_name == "title" and isinstance(value, str):
            self.title = value.strip()
        elif field_name == "description" and isinstance(value, str):
            self.description = value.strip()
        elif field_name == "scam":
            self.scam = bool(value)
        elif field_name == "verified":
            self.verified = bool(value)
        elif field_name == "n_subscribers":
            try:
                self.n_subscribers = max(0, int(value or 0))
            except (TypeError, ValueError):
                self.n_subscribers = 0

    def finalize_metadata(self) -> None:
        evidence = "\n".join(part for part in (self.username, self.title, self.description) if part)
        self.metadata_crypto = bool(_CRYPTO_RE.search(evidence) or _MEME_RE.search(evidence) or _SOLANA_RE.search(evidence))
        self.metadata_memecoin = bool(_MEME_RE.search(evidence))
        self.metadata_solana = bool(_SOLANA_RE.search(evidence))
        self.metadata_caller = bool(_CALL_RE.search(evidence) and self.metadata_crypto)

    def observe_forwarded(self, value: Any) -> None:
        if bool(value):
            self.forwarded_messages += 1

    def observe_message(self, text: str) -> None:
        self.messages_total += 1
        text = text or ""
        if not text or not _GATE_RE.search(text):
            return

        self.signal_messages += 1
        crypto_hit = bool(_CRYPTO_RE.search(text))
        meme_hit = bool(_MEME_RE.search(text))
        solana_hit = bool(_SOLANA_RE.search(text))
        call_hit = bool(_CALL_RE.search(text))
        pumpfun_hit = bool(_PUMPFUN_RE.search(text))
        evm_contracts = _EVM_CONTRACT_RE.findall(text)
        parsed = parse_telegram_message(text)

        if parsed.addresses:
            solana_hit = True
            for address in parsed.addresses:
                if len(self._solana_mints) < _MAX_UNIQUE_CONTRACTS:
                    self._solana_mints.add(address)
        if evm_contracts:
            for address in evm_contracts:
                if len(self._evm_contracts) < _MAX_UNIQUE_CONTRACTS:
                    self._evm_contracts.add(address.lower())

        token_evidence = bool(parsed.addresses or evm_contracts or parsed.tickers)
        if meme_hit or solana_hit or token_evidence:
            crypto_hit = True
        if crypto_hit:
            self.crypto_messages += 1
        if meme_hit:
            self.memecoin_messages += 1
        if solana_hit:
            self.solana_messages += 1
        if parsed.addresses or evm_contracts:
            self.contract_messages += 1
        if parsed.tickers:
            self.ticker_messages += 1
        if pumpfun_hit:
            self.pumpfun_messages += 1
        if parsed.telegram_links:
            self.telegram_links += len(parsed.telegram_links)
        if parsed.explicit_call or (call_hit and token_evidence and crypto_hit):
            self.explicit_call_messages += 1

    def scores(self) -> dict[str, float]:
        total = max(1, self.messages_total)
        unique_contracts = len(self._solana_mints) + len(self._evm_contracts)

        crypto = (
            (25.0 if self.metadata_crypto else 0.0)
            + _scaled_count(self.crypto_messages, 50, 35.0)
            + _density(self.crypto_messages, total, 25.0)
            + _scaled_count(unique_contracts, 20, 15.0)
        )
        memecoin = (
            (25.0 if self.metadata_memecoin else 0.0)
            + _scaled_count(self.memecoin_messages, 20, 35.0)
            + _density(self.memecoin_messages, total, 25.0)
            + _scaled_count(self.explicit_call_messages if self.memecoin_messages else 0, 10, 15.0)
        )
        solana = (
            (20.0 if self.metadata_solana else 0.0)
            + _scaled_count(self.solana_messages, 15, 25.0)
            + _scaled_count(len(self._solana_mints), 10, 35.0)
            + _density(self.solana_messages, total, 20.0)
        )
        caller = (
            (10.0 if self.metadata_caller else 0.0)
            + _scaled_count(self.explicit_call_messages, 15, 50.0)
            + _density(self.explicit_call_messages, total, 25.0)
            + _scaled_count(unique_contracts, 20, 15.0)
        )
        return {
            "crypto": round(min(100.0, crypto), 1),
            "memecoin": round(min(100.0, memecoin), 1),
            "solana": round(min(100.0, solana), 1),
            "caller": round(min(100.0, caller), 1),
        }

    def result(self) -> dict[str, Any]:
        self.finalize_metadata()
        scores = self.scores()
        classifications: list[str] = []
        if scores["crypto"] >= 35.0:
            classifications.append("crypto")
        if scores["memecoin"] >= 30.0 and scores["crypto"] >= 30.0:
            classifications.append("memecoin")
        if scores["solana"] >= 30.0 and scores["crypto"] >= 25.0:
            classifications.append("solana")
        if scores["caller"] >= 30.0 and scores["crypto"] >= 25.0:
            classifications.append("caller")
        if "memecoin" in classifications and "caller" in classifications:
            classifications.append("memecoin_calls")
        if "solana" in classifications and (scores["memecoin"] >= 25.0 or "caller" in classifications):
            classifications.append("solana_memecoin")

        seed_score = round(
            min(
                100.0,
                scores["crypto"] * 0.15
                + scores["memecoin"] * 0.30
                + scores["solana"] * 0.35
                + scores["caller"] * 0.20,
            ),
            1,
        )
        return {
            "channel_id": self.channel_id,
            "username": self.username,
            "title": self.title,
            "description": self.description,
            "scam": self.scam,
            "verified": self.verified,
            "n_subscribers": self.n_subscribers,
            "scores": scores,
            "seed_score": seed_score,
            "classifications": classifications,
            "signals": {
                "messages_total": self.messages_total,
                "signal_messages": self.signal_messages,
                "crypto_messages": self.crypto_messages,
                "memecoin_messages": self.memecoin_messages,
                "solana_messages": self.solana_messages,
                "contract_messages": self.contract_messages,
                "explicit_call_messages": self.explicit_call_messages,
                "ticker_messages": self.ticker_messages,
                "pumpfun_messages": self.pumpfun_messages,
                "forwarded_messages": self.forwarded_messages,
                "telegram_links": self.telegram_links,
                "unique_solana_mints": len(self._solana_mints),
                "unique_evm_contracts": len(self._evm_contracts),
            },
        }


def iter_tgdataset_channels(fileobj: BinaryIO) -> Iterator[dict[str, Any]]:
    """Parse one TGDataset JSON member incrementally without loading it into memory."""

    try:
        import ijson
    except ImportError as exc:  # pragma: no cover - dependency guard for manual environments
        raise RuntimeError("TGDataset scanning requires ijson. Install the backend dependencies first.") from exc

    current: TGDatasetChannelAccumulator | None = None
    current_id = ""
    for prefix, event, value in ijson.parse(fileobj):
        if prefix == "" and event == "map_key":
            if current is not None:
                yield current.result()
            current_id = str(value)
            current = TGDatasetChannelAccumulator(channel_id=current_id)
            continue
        if current is None or not current_id:
            continue
        base = current_id + "."
        if not prefix.startswith(base):
            continue
        relative = prefix[len(base) :]

        if relative in {"username", "title", "description", "scam", "verified", "n_subscribers"}:
            if event in {"string", "number", "boolean", "null"}:
                current.observe_metadata(relative, value)
            continue
        if relative.startswith("text_messages.") and relative.endswith(".message") and event == "string":
            current.observe_message(str(value or ""))
            continue
        if relative.startswith("text_messages.") and relative.endswith(".is_forwarded") and event == "boolean":
            current.observe_forwarded(value)
            continue
        if relative.startswith("generic_media.") and relative.endswith(".title") and event == "string":
            title = str(value or "")
            if title and _GATE_RE.search(title):
                current.observe_message(title)

    if current is not None:
        yield current.result()


@dataclass(slots=True)
class ArchiveScanStats:
    archive: str
    json_members: int = 0
    channels_scanned: int = 0
    candidates: int = 0
    messages_scanned: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "archive": self.archive,
            "json_members": self.json_members,
            "channels_scanned": self.channels_scanned,
            "candidates": self.candidates,
            "messages_scanned": self.messages_scanned,
        }


def scan_tar_stream(
    fileobj: BinaryIO,
    *,
    archive_name: str,
    on_candidate: Callable[[dict[str, Any]], None],
    max_channels: int | None = None,
    progress: Callable[[str], None] | None = None,
) -> ArchiveScanStats:
    stats = ArchiveScanStats(archive=archive_name)
    with tarfile.open(fileobj=fileobj, mode="r|gz") as archive:
        for member in archive:
            if not member.isfile() or not member.name.lower().endswith(".json"):
                continue
            extracted = archive.extractfile(member)
            if extracted is None:
                continue
            stats.json_members += 1
            for channel in iter_tgdataset_channels(extracted):
                stats.channels_scanned += 1
                stats.messages_scanned += int(channel.get("signals", {}).get("messages_total") or 0)
                if channel.get("classifications"):
                    stats.candidates += 1
                    on_candidate(channel)
                if max_channels is not None and stats.channels_scanned >= max_channels:
                    return stats
            if progress is not None:
                progress(
                    f"[{archive_name}] files={stats.json_members} channels={stats.channels_scanned} "
                    f"candidates={stats.candidates} messages={stats.messages_scanned}"
                )
    return stats


def _load_jsonl(paths: Iterable[Path]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in paths:
        if not path.exists():
            continue
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(row, dict):
                    rows.append(row)
    return rows


def build_outputs(output_dir: Path, *, seed_limit: int = 250) -> dict[str, Any]:
    candidate_paths = [output_dir / f"{name}.candidates.jsonl" for name in ZENODO_ARCHIVES]
    rows = _load_jsonl(candidate_paths)
    deduped: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = str(row.get("username") or row.get("channel_id") or "").strip().lower()
        if not key:
            continue
        previous = deduped.get(key)
        if previous is None or float(row.get("seed_score") or 0.0) > float(previous.get("seed_score") or 0.0):
            deduped[key] = row
    rows = list(deduped.values())
    rows.sort(key=lambda row: (float(row.get("seed_score") or 0.0), int(row.get("n_subscribers") or 0)), reverse=True)

    categories = {
        "crypto_channels.json": "crypto",
        "memecoin_channels.json": "memecoin",
        "solana_channels.json": "solana",
        "caller_channels.json": "caller",
    }
    for filename, label in categories.items():
        selected = [row for row in rows if label in (row.get("classifications") or [])]
        (output_dir / filename).write_text(json.dumps(selected, ensure_ascii=False, indent=2), encoding="utf-8")

    seed_candidates = [
        row
        for row in rows
        if row.get("username")
        and not row.get("scam")
        and any(
            label in (row.get("classifications") or [])
            for label in ("memecoin", "solana", "caller", "memecoin_calls", "solana_memecoin")
        )
    ][: max(1, seed_limit)]
    seed_payload = {
        "version": 1,
        "generated_at": utcnow_iso(),
        "source": f"zenodo:{ZENODO_RECORD_ID}",
        "note": "Historical candidates only. Public-web collector must revalidate current relevance before use.",
        "channels": [
            {
                "username": row["username"],
                "seed_score": row.get("seed_score"),
                "scores": row.get("scores"),
                "classifications": row.get("classifications"),
                "n_subscribers": row.get("n_subscribers"),
            }
            for row in seed_candidates
        ],
    }
    seed_path = output_dir / "telegram_seed_database.json"
    seed_path.write_text(json.dumps(seed_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    summary = {
        "generated_at": utcnow_iso(),
        "candidate_channels": len(rows),
        "crypto_channels": sum("crypto" in (row.get("classifications") or []) for row in rows),
        "memecoin_channels": sum("memecoin" in (row.get("classifications") or []) for row in rows),
        "solana_channels": sum("solana" in (row.get("classifications") or []) for row in rows),
        "caller_channels": sum("caller" in (row.get("classifications") or []) for row in rows),
        "seed_channels": len(seed_candidates),
        "seed_database": str(seed_path),
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary


def scan_archives(
    *,
    output_dir: str | Path,
    archive_numbers: Iterable[int] = (1, 2, 3, 4),
    local_dir: str | Path | None = None,
    resume: bool = True,
    seed_limit: int = 250,
    max_channels: int | None = None,
    progress: Callable[[str], None] | None = print,
) -> dict[str, Any]:
    """Stream selected TGDataset archives and keep only candidate metadata on disk.

    When local_dir is None, each archive is consumed directly from Zenodo via HTTP and is never
    stored on disk. Resume is archive-granular because gzip streams cannot be resumed safely in
    the middle without re-reading the archive.
    """

    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    selected = []
    for number in archive_numbers:
        number = int(number)
        if number not in {1, 2, 3, 4}:
            raise ValueError("Archive numbers must be between 1 and 4")
        name = f"TGDataset_{number}.tar.gz"
        if name not in selected:
            selected.append(name)

    manifest_path = destination / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    except json.JSONDecodeError:
        manifest = {}
    completed = set(manifest.get("completed_archives") or [])
    archive_stats: list[dict[str, Any]] = []

    for archive_name in selected:
        final_candidates = destination / f"{archive_name}.candidates.jsonl"
        final_stats = destination / f"{archive_name}.stats.json"
        if resume and archive_name in completed and final_candidates.exists() and final_stats.exists():
            archive_stats.append(json.loads(final_stats.read_text(encoding="utf-8")))
            if progress is not None:
                progress(f"[{archive_name}] already completed; skipping")
            continue

        partial = final_candidates.with_suffix(final_candidates.suffix + ".partial")
        partial.unlink(missing_ok=True)
        source_path: Path | None = None
        source_url: str | None = None
        if local_dir is not None:
            source_path = Path(local_dir) / archive_name
            if not source_path.exists():
                raise FileNotFoundError(source_path)
        else:
            source_url = zenodo_archive_url(archive_name)

        if progress is not None:
            progress(f"[{archive_name}] starting {'local' if source_path else 'Zenodo stream'} scan")

        with partial.open("w", encoding="utf-8") as output:
            def emit(row: dict[str, Any]) -> None:
                output.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")

            if source_path is not None:
                with source_path.open("rb") as stream:
                    stats = scan_tar_stream(
                        stream,
                        archive_name=archive_name,
                        on_candidate=emit,
                        max_channels=max_channels,
                        progress=progress,
                    )
            else:
                request = Request(source_url or "", headers={"User-Agent": _USER_AGENT}, method="GET")
                with urlopen(request, timeout=120) as stream:  # noqa: S310 - fixed Zenodo dataset URLs only
                    stats = scan_tar_stream(
                        stream,
                        archive_name=archive_name,
                        on_candidate=emit,
                        max_channels=max_channels,
                        progress=progress,
                    )

        partial.replace(final_candidates)
        stats_payload = stats.as_dict()
        stats_payload["completed_at"] = utcnow_iso()
        stats_payload["source"] = str(source_path) if source_path else source_url
        final_stats.write_text(json.dumps(stats_payload, ensure_ascii=False, indent=2), encoding="utf-8")
        archive_stats.append(stats_payload)
        completed.add(archive_name)
        manifest = {
            "version": 1,
            "record_id": ZENODO_RECORD_ID,
            "completed_archives": sorted(completed),
            "updated_at": utcnow_iso(),
        }
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    summary = build_outputs(destination, seed_limit=seed_limit)
    summary["archives"] = archive_stats
    (destination / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary
