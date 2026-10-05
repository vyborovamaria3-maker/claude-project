from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from telethon import TelegramClient
from telethon.errors import (
    ChannelPrivateError,
    FloodWaitError,
    UsernameNotOccupiedError,
)
from telethon.tl.types import Channel

# Precision-first live classifiers.
# Generic words such as jupiter/orca/phantom/ape/cto are intentionally
# excluded from standalone target detection because they create large
# numbers of non-crypto false positives.
SOLANA_KEYWORDS = re.compile(
    r"(?<![A-Za-z0-9_])(?:"
    r"solana|\$sol|raydium|solscan|spl\s*token|"
    r"pump\.fun|pumpfun"
    r")(?![A-Za-z0-9_])",
    re.IGNORECASE,
)
MEMECOIN_KEYWORDS = re.compile(
    r"(?<![A-Za-z0-9_])(?:"
    r"memecoin|meme\s*coin|meme\s*token|bonk|dogwifhat|\$wif|"
    r"pepe|degen|moonshot|shitcoin"
    r")(?![A-Za-z0-9_])",
    re.IGNORECASE,
)
CALL_KEYWORDS = re.compile(
    r"(?<![A-Za-z0-9_])(?:"
    r"call|calling|caller|gem|alpha|entry|buy|send(?:ing)?|aping|"
    r"moon|100x|50x|20x|10x|launch|market\s*cap|mcap|ca|contract"
    r")(?![A-Za-z0-9_])",
    re.IGNORECASE,
)
PUMPFUN_KEYWORDS = re.compile(
    r"(?<![A-Za-z0-9_])(?:pump\.fun|pumpfun)(?![A-Za-z0-9_])",
    re.IGNORECASE,
)
SOLANA_CONTRACT_RE = re.compile(
    r"(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])"
)
EVM_CONTRACT_RE = re.compile(r"(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])")


def analyze_text(text: str) -> dict[str, Any]:
    solana = bool(SOLANA_KEYWORDS.search(text))
    memecoin = bool(MEMECOIN_KEYWORDS.search(text))
    call = bool(CALL_KEYWORDS.search(text))
    pumpfun = bool(PUMPFUN_KEYWORDS.search(text))
    target = solana or memecoin or pumpfun
    signal = target or call
    solana_contracts = SOLANA_CONTRACT_RE.findall(text)
    evm_contracts = EVM_CONTRACT_RE.findall(text)
    return {
        "signal": signal,
        "target": target,
        "solana": solana,
        "memecoin": memecoin,
        "call": call,
        "pumpfun": pumpfun,
        "solana_contracts": solana_contracts,
        "evm_contracts": evm_contracts,
    }


def score_analysis(stats: dict[str, int]) -> dict[str, Any]:
    msgs = stats["messages_analyzed"]
    if msgs == 0:
        return {"essence_score": 0.0, "verdict": "reject", "reasons": ["no_messages"]}

    solana_ratio = stats["solana_messages"] / msgs
    memecoin_ratio = stats["memecoin_messages"] / msgs
    call_ratio = stats["call_messages"] / msgs
    pumpfun_ratio = stats["pumpfun_messages"] / msgs

    score = 0.0
    reasons = []

    if solana_ratio > 0.1:
        score += 30
        reasons.append("solana_relevant")
    if memecoin_ratio > 0.05:
        score += 25
        reasons.append("memecoin_relevant")
    if call_ratio > 0.1:
        score += 20
        reasons.append("caller_relevant")
    if pumpfun_ratio > 0.02:
        score += 15
        reasons.append("pumpfun_relevant")
    # Generic call vocabulary must not create a strong source by itself.
    if stats.get("target_messages", 0) >= 2 and stats["signal_messages"] > msgs * 0.3:
        score += 10
        reasons.append("high_signal_density")

    if score >= 60:
        verdict = "strong"
    elif score >= 40:
        verdict = "medium"
    elif score >= 20:
        verdict = "weak"
    else:
        verdict = "reject"

    return {"essence_score": round(score, 1), "verdict": verdict, "reasons": reasons}


async def validate_channel(
    client: TelegramClient,
    username: str,
    limit: int = 100,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "username": username,
        "can_resolve": False,
        "can_read_messages": False,
        "can_get_participants": False,
        "messages_analyzed": 0,
        "solana_messages": 0,
        "memecoin_messages": 0,
        "call_messages": 0,
        "pumpfun_messages": 0,
        "signal_messages": 0,
        "target_messages": 0,
        "solana_contracts": [],
        "evm_contracts": [],
        "extractable_users": 0,
        "parse_mode": "none",
        "essence_score": 0.0,
        "verdict": "reject",
        "reasons": [],
        "error": None,
    }

    try:
        entity = await client.get_entity(username)
        result["can_resolve"] = True

        if isinstance(entity, Channel):
            result["title"] = entity.title
            result["channel_id"] = entity.id
        else:
            result["reasons"] = ["not_a_channel"]
            return result

    except UsernameNotOccupiedError:
        result["error"] = "username_not_occupied"
        result["reasons"] = ["username_not_occupied"]
        return result
    except ChannelPrivateError:
        result["error"] = "channel_private"
        result["reasons"] = ["channel_private"]
        return result
    except FloodWaitError as e:
        result["error"] = f"flood_wait_{e.seconds}s"
        result["reasons"] = ["flood_wait"]
        return result
    except Exception as e:
        result["error"] = str(e)
        result["reasons"] = ["resolve_failed"]
        return result

    try:
        messages = await client.get_messages(entity, limit=limit)
        if messages:
            result["can_read_messages"] = True
            result["messages_analyzed"] = len(messages)

            solana_contracts: set[str] = set()
            evm_contracts: set[str] = set()

            for msg in messages:
                text = msg.message or ""
                analysis = analyze_text(text)
                if analysis["signal"]:
                    result["signal_messages"] += 1
                if analysis["target"]:
                    result["target_messages"] += 1
                if analysis["solana"]:
                    result["solana_messages"] += 1
                if analysis["memecoin"]:
                    result["memecoin_messages"] += 1
                if analysis["call"]:
                    result["call_messages"] += 1
                if analysis["pumpfun"]:
                    result["pumpfun_messages"] += 1
                for c in analysis["solana_contracts"]:
                    solana_contracts.add(c)
                for c in analysis["evm_contracts"]:
                    evm_contracts.add(c)

            result["solana_contracts"] = list(solana_contracts)
            result["evm_contracts"] = list(evm_contracts)

            score_result = score_analysis(
                {
                    "messages_analyzed": result["messages_analyzed"],
                    "solana_messages": result["solana_messages"],
                    "memecoin_messages": result["memecoin_messages"],
                    "call_messages": result["call_messages"],
                    "pumpfun_messages": result["pumpfun_messages"],
                    "signal_messages": result["signal_messages"],
                    "target_messages": result["target_messages"],
                }
            )
            result["essence_score"] = score_result["essence_score"]
            result["verdict"] = score_result["verdict"]
            result["reasons"] = score_result["reasons"]

    except FloodWaitError as e:
        result["error"] = f"flood_wait_{e.seconds}s"
        result["reasons"] = ["flood_wait_messages"]
        return result
    except Exception as e:
        result["error"] = str(e)
        result["reasons"] = ["messages_failed"]
        return result

    # Parser access is only a capability probe here.
    # Do not enumerate a whole channel during source validation.
    try:
        participants = await client.get_participants(entity, limit=1)
        if participants:
            result["can_get_participants"] = True
            result["extractable_users"] = len(participants)
            result["parse_mode"] = "participants_probe"
    except Exception:
        pass

    if not result["can_get_participants"]:
        try:
            count = 0
            async for _user in client.iter_participants(
                entity,
                limit=1,
                aggressive=False,
            ):
                count += 1

            if count:
                result["extractable_users"] = count
                result["parse_mode"] = "iter_participants_probe"
        except Exception:
            pass

    return result


def load_checkpoint(checkpoint_path: Path) -> dict[str, Any]:
    checked: dict[str, dict[str, Any]] = {}
    if checkpoint_path.is_file():
        for line in checkpoint_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                username = row.get("username", "")
                if username:
                    checked[username.lower()] = row
            except json.JSONDecodeError:
                pass
    return checked


def append_checkpoint(checkpoint_path: Path, entry: dict[str, Any]) -> None:
    with checkpoint_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def write_verified_sources(
    output: Path,
    verified: list[dict[str, Any]],
    stats: dict[str, Any],
) -> Path:
    verified.sort(
        key=lambda x: (
            x.get("can_parse_users", False),
            x.get("live_essence_score", 0),
            x.get("extractable_users", 0),
        ),
        reverse=True,
    )

    verified_path = output / "verified_sources.json"
    verified_path.write_text(
        json.dumps(
            {
                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                **stats,
                "sources": verified,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return verified_path


async def run_curator(
    input_dir: str,
    output_dir: str,
    seed_limit: int,
    recent_messages_per_chat: int,
    signal_source: str,
    memory_limit: str,
    threads: int,
    fetch_size: int,
    api_id: int,
    api_hash: str,
    session_name: str,
    live_limit: int,
    live_max: int | None,
    skip_scan: bool,
    progress: Any = None,
) -> dict[str, Any]:
    def log(msg: str) -> None:
        if progress:
            progress(msg)
        print(msg, flush=True)

    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)  # noqa: ASYNC240

    checkpoint_path = output / "curator_checkpoint.jsonl"

    if not skip_scan:
        log("=== PHASE 1: Full TeraGram scan ===")
        from app.services.teragram_scanner import scan_teragram_dataset

        scan_result = scan_teragram_dataset(
            input_dir=input_dir,
            output_dir=output,
            seed_limit=seed_limit,
            max_chats=None,
            recent_messages_per_chat=recent_messages_per_chat,
            signal_source=signal_source,
            threads=threads,
            memory_limit=memory_limit,
            fetch_size=fetch_size,
            progress=progress,
        )
        log(f"Scan complete: {scan_result.get('candidate_channels', 0)} candidates")

        candidates_path = output / "teragram_candidates.jsonl"
        if not candidates_path.is_file():
            log(f"ERROR: Candidates file not found: {candidates_path}")
            return {"error": "candidates_not_found"}

        log("=== PHASE 2: Graph discovery expansion ===")
        from app.services.teragram_graph_discovery import discover_teragram_graph

        discovery_output = output / "discovery.json"
        discover_teragram_graph(
            input_dir=input_dir,
            candidate_path=str(candidates_path),
            output_path=str(discovery_output),
            min_audience_overlap=2,
            max_results=500,
            threads=threads,
            memory_limit=memory_limit,
        )
        log("Discovery complete")
    else:
        log("=== SKIP SCAN: using existing candidates + discovery ===")

    candidates_path = output / "teragram_candidates.jsonl"
    discovery_output = output / "discovery.json"

    all_usernames: list[dict[str, Any]] = []
    seen: set[str] = set()

    if candidates_path.is_file():
        for line in candidates_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            username = row.get("username", "").strip().lstrip("@").lower()
            if not username or username in seen:
                continue
            seen.add(username)
            all_usernames.append(
                {
                    "username": username,
                    "title": row.get("title", ""),
                    "historical_discovery_score": row.get("seed_score", 0),
                    "source": "scan",
                }
            )

    if discovery_output.is_file():
        try:
            disc = json.loads(discovery_output.read_text(encoding="utf-8"))
            for cand in disc.get("candidates", []):
                username = cand.get("username", "").strip().lstrip("@").lower()
                if not username or username in seen:
                    continue
                seen.add(username)
                all_usernames.append(
                    {
                        "username": username,
                        "title": cand.get("title", ""),
                        "historical_discovery_score": cand.get("historical_discovery_score", 0),
                        "source": "discovery",
                    }
                )
        except (json.JSONDecodeError, OSError):
            pass

    log(f"Total unique candidates: {len(all_usernames)}")

    checked_map = load_checkpoint(checkpoint_path)
    already_checked = set(checked_map.keys())
    remaining = [c for c in all_usernames if c["username"] not in already_checked]

    if live_max is not None:
        remaining = remaining[:live_max]

    log(f"Already checked: {len(already_checked)}")
    log(f"Remaining:       {len(remaining)}")

    log("=== PHASE 3: Live MTProto validation ===")
    session_path = output / f"{session_name}.session"
    client = TelegramClient(str(session_path), api_id, api_hash)
    await client.start()

    verified: list[dict[str, Any]] = [
        v for v in checked_map.values() if v.get("status") == "accepted"
    ]

    stats = {
        "total_candidates": len(all_usernames),
        "checked": len(already_checked),
        "alive": sum(1 for v in checked_map.values() if v.get("alive")),
        "accepted": len(verified),
        "rejected": sum(1 for v in checked_map.values() if v.get("status") == "rejected"),
    }

    for i, cand in enumerate(remaining):
        username = cand["username"]
        log(f"[{len(already_checked) + i + 1}/{len(all_usernames)}] Validating @{username}...")

        result = await validate_channel(client, username, limit=live_limit)

        can_parse_users = result["extractable_users"] > 0
        parser_access_status = "available" if can_parse_users else "unavailable"

        # Source quality is independent from participant-list availability.
        # Keep an explicit Solana/memecoin signal guard so generic channels
        # cannot pass only because of broad crypto/call vocabulary.
        # Repeated target evidence is required. A single ambiguous word
        # in a political/news/art channel must not qualify it as a source.
        target_messages = result["target_messages"]
        messages_analyzed = result["messages_analyzed"]

        if messages_analyzed >= 20:
            has_target_signal = (
                target_messages >= 3 and (target_messages / messages_analyzed) >= 0.03
            )
        else:
            has_target_signal = (
                target_messages >= 2 and (target_messages / max(messages_analyzed, 1)) >= 0.20
            )

        is_accepted = (
            result["verdict"] in ("strong", "medium")
            and result["can_read_messages"]
            and has_target_signal
        )

        entry = {
            "username": username,
            "status": "accepted" if is_accepted else "rejected",
            "alive": result["can_resolve"],
            "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "live_essence_score": result["essence_score"],
            "verdict": result["verdict"],
            "messages_analyzed": result["messages_analyzed"],
            "extractable_users": result["extractable_users"],
            "can_parse_users": can_parse_users,
            "parser_access_status": parser_access_status,
            "parse_mode": result["parse_mode"],
            "solana_messages": result["solana_messages"],
            "memecoin_messages": result["memecoin_messages"],
            "call_messages": result["call_messages"],
            "pumpfun_messages": result["pumpfun_messages"],
            "signal_messages": result["signal_messages"],
            "target_messages": result["target_messages"],
            "reasons": result["reasons"],
            "error": result.get("error"),
        }

        append_checkpoint(checkpoint_path, entry)

        if is_accepted:
            stats["accepted"] += 1
            verified.append(
                {
                    "username": username,
                    "title": result.get("title", cand["title"]),
                    "category": (
                        "memecoin"
                        if result["memecoin_messages"] > result["solana_messages"]
                        else "solana"
                    )
                    if max(result["memecoin_messages"], result["solana_messages"]) > 0
                    else "crypto",
                    "live_essence_score": result["essence_score"],
                    "verdict": result["verdict"],
                    "messages_analyzed": result["messages_analyzed"],
                    "can_parse_users": can_parse_users,
                    "parser_access_status": parser_access_status,
                    "parse_mode": result["parse_mode"],
                    "extractable_users": result["extractable_users"],
                    "solana_messages": result["solana_messages"],
                    "memecoin_messages": result["memecoin_messages"],
                    "call_messages": result["call_messages"],
                    "pumpfun_messages": result["pumpfun_messages"],
                    "solana_contracts": result["solana_contracts"],
                    "evm_contracts": result["evm_contracts"],
                    "historical_discovery_score": cand["historical_discovery_score"],
                    "source": cand["source"],
                }
            )
            log(
                f"  -> ACCEPTED (score={result['essence_score']}, "
                f"parser={parser_access_status}, users={result['extractable_users']})"
            )
        else:
            stats["rejected"] += 1
            log(f"  -> rejected ({result['verdict']}, error={result.get('error', 'none')})")

        if result["can_resolve"]:
            stats["alive"] += 1

        stats["checked"] += 1

        if result.get("error") and "flood_wait" in str(result["error"]):
            wait_match = re.search(r"flood_wait_(\d+)s", str(result["error"]))
            if wait_match:
                wait_sec = int(wait_match.group(1)) + 5
                log(f"  FLOOD_WAIT: sleeping {wait_sec}s...")
                await asyncio.sleep(wait_sec)

        await asyncio.sleep(1)

    await client.disconnect()

    verified_path = write_verified_sources(output, verified, stats)

    log("")
    log("=== CURATOR COMPLETE ===")
    log(f"Total candidates:  {stats['total_candidates']}")
    log(f"Checked:           {stats['checked']}")
    log(f"Alive:             {stats['alive']}")
    log(f"Accepted:          {stats['accepted']}")
    log(f"Rejected:          {stats['rejected']}")
    log(f"Verified sources:  {verified_path}")
    log(f"Checkpoint:        {checkpoint_path}")

    return {**stats, "verified_path": str(verified_path)}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Full TeraGram curator: scan dataset, discover graph candidates, "
            "validate live via MTProto, output verified sources only."
        )
    )
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output", default="data/teragram_curated")
    parser.add_argument("--seed-limit", type=int, default=5000)
    parser.add_argument("--recent-messages-per-chat", type=int, default=100)
    parser.add_argument(
        "--signal-source",
        choices=("auto", "content", "entities", "metadata"),
        default="auto",
    )
    parser.add_argument("--memory-limit", default="4GB")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--fetch-size", type=int, default=10_000)
    parser.add_argument("--api-id", type=int, default=None)
    parser.add_argument("--api-hash", default=None)
    parser.add_argument("--session-name", default="teragram_curator")
    parser.add_argument("--live-limit", type=int, default=100)
    parser.add_argument(
        "--live-max",
        type=int,
        default=None,
        help="max channels to validate in Phase 3 (None = all)",
    )
    parser.add_argument(
        "--skip-scan",
        action="store_true",
        help="skip Phase 1/2, use existing candidates + discovery",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    api_id = args.api_id or int(os.getenv("TG_API_ID", "0"))
    api_hash = args.api_hash or os.getenv("TG_API_HASH", "")

    if not api_id or not api_hash:
        parser.error(
            "Telegram API credentials required. "
            "Set --api-id/--api-hash or TG_API_ID/TG_API_HASH env vars."
        )

    asyncio.run(
        run_curator(
            input_dir=args.input_dir,
            output_dir=args.output,
            seed_limit=args.seed_limit,
            recent_messages_per_chat=args.recent_messages_per_chat,
            signal_source=args.signal_source,
            memory_limit=args.memory_limit,
            threads=args.threads,
            fetch_size=args.fetch_size,
            api_id=api_id,
            api_hash=api_hash,
            session_name=args.session_name,
            live_limit=args.live_limit,
            live_max=args.live_max,
            skip_scan=args.skip_scan,
        )
    )


if __name__ == "__main__":
    main()
