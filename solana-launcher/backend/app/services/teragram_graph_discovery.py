from __future__ import annotations


import json
import math
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


from app.services.teragram_scanner import (
    _configure_duckdb,
    _relation_sql,
    _require_duckdb,
    discover_teragram_sources,
)




_TME_RE = re.compile(
    r"https?://(?:www\.)?(?:t\.me|telegram\.me)/(?:s/)?([a-zA-Z0-9_]{5,32})",
    re.IGNORECASE,
)




def _now() -> str:
    return datetime.now(timezone.utc).isoformat()




def _load_roots(candidate_path: Path) -> list[int]:
    roots: list[int] = []

    with candidate_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue

            row = json.loads(line)

            signals = row.get("signals") or {}
            classifications = {
                str(value).strip().lower()
                for value in (row.get("classifications") or [])
            }

            has_target_signal = (
                int(signals.get("solana_messages", 0) or 0) > 0
                or int(signals.get("memecoin_messages", 0) or 0) > 0
                or int(signals.get("pumpfun_messages", 0) or 0) > 0
                or int(signals.get("unique_solana_mints", 0) or 0) > 0
                or "solana" in classifications
                or "memecoin" in classifications
            )

            if not has_target_signal:
                continue

            value = row.get("teragram_chat_id")

            try:
                roots.append(int(value))
            except (TypeError, ValueError):
                continue

    return sorted(set(roots))




def discover_teragram_graph(
    *,
    input_dir: str | Path,
    candidate_path: str | Path,
    output_path: str | Path,
    min_audience_overlap: int = 2,
    max_results: int = 500,
    threads: int | None = 4,
    memory_limit: str = "4GB",
) -> dict[str, Any]:
    if min_audience_overlap < 1:
        raise ValueError("min_audience_overlap must be positive")
    if max_results < 1:
        raise ValueError("max_results must be positive")


    sources = discover_teragram_sources(input_dir)


    candidate_file = Path(candidate_path).expanduser().resolve()
    if not candidate_file.is_file():
        raise FileNotFoundError(candidate_file)


    roots = _load_roots(candidate_file)

    output = Path(output_path).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    if not roots:
        payload = {
            "generated_at": _now(),
            "source": "teragram_graph_discovery",
            "root_candidate_count": 0,
            "candidate_count": 0,
            "min_audience_overlap": min_audience_overlap,
            "max_results": max_results,
            "note": (
                "Graph expansion skipped because no historical "
                "Solana or memecoin roots passed the root gate."
            ),
            "candidates": [],
        }

        output.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        return payload

    duckdb = _require_duckdb()


    database = output.with_suffix(".duckdb")
    temp_dir = output.parent / "graph_duckdb_tmp"


    connection = duckdb.connect(str(database))


    try:
        _configure_duckdb(
            connection,
            threads=threads,
            memory_limit=memory_limit,
            temp_dir=temp_dir,
        )


        connection.execute(
            f"""
            CREATE OR REPLACE TEMP VIEW tg_chats AS
            SELECT *
            FROM {_relation_sql(sources.chats)}
            """
        )


        connection.execute(
            f"""
            CREATE OR REPLACE TEMP VIEW tg_messages AS
            SELECT *
            FROM {_relation_sql(sources.messages)}
            """
        )


        if sources.entity_urls:
            connection.execute(
                f"""
                CREATE OR REPLACE TEMP VIEW tg_entity_urls AS
                SELECT *
                FROM {_relation_sql(sources.entity_urls)}
                """
            )


        if sources.chats_users:
            connection.execute(
                f"""
                CREATE OR REPLACE TEMP VIEW tg_chats_users AS
                SELECT *
                FROM {_relation_sql(sources.chats_users)}
                """
            )


        connection.execute(
            """
            CREATE OR REPLACE TEMP TABLE tg_graph_roots (
                chat_id BIGINT PRIMARY KEY
            )
            """
        )


        connection.executemany(
            "INSERT INTO tg_graph_roots VALUES (?)",
            [(value,) for value in roots],
        )


        evidence: dict[int, dict[str, Any]] = defaultdict(
            lambda: {
                "linked": 0,
                "forward_count": 0,
                "tme_count": 0,
                "audience_overlap": 0,
                "root_connections": set(),
            }
        )


        # --------------------------------------------------------
        # 1. linked_chat_id, both directions
        # --------------------------------------------------------


        linked_rows = connection.execute(
            """
            SELECT
                r.chat_id AS root_id,
                c.linked_chat_id AS target_id
            FROM tg_graph_roots r
            INNER JOIN tg_chats c ON c.id = r.chat_id
            WHERE c.linked_chat_id IS NOT NULL


            UNION ALL


            SELECT
                r.chat_id AS root_id,
                c.id AS target_id
            FROM tg_graph_roots r
            INNER JOIN tg_chats c ON c.linked_chat_id = r.chat_id
            """
        ).fetchall()


        for root_id, target_id in linked_rows:
            if target_id is None:
                continue


            target = int(target_id)
            if target in roots:
                continue


            item = evidence[target]
            item["linked"] += 1
            item["root_connections"].add(int(root_id))


        # --------------------------------------------------------
        # 2. historical forwards into roots
        # --------------------------------------------------------


        forward_rows = connection.execute(
            """
            SELECT
                m.forward_from_chat_id AS target_id,
                COUNT(*)::BIGINT AS n,
                COUNT(DISTINCT m.chat_id)::BIGINT AS roots
            FROM tg_messages m
            INNER JOIN tg_graph_roots r
                ON r.chat_id = m.chat_id
            WHERE m.forward_from_chat_id IS NOT NULL
              AND m.forward_from_chat_id NOT IN (
                  SELECT chat_id FROM tg_graph_roots
              )
            GROUP BY m.forward_from_chat_id
            """
        ).fetchall()


        for target_id, count, root_count in forward_rows:
            target = int(target_id)
            item = evidence[target]
            item["forward_count"] = int(count or 0)
            item["forward_root_count"] = int(root_count or 0)


        # --------------------------------------------------------
        # 3. t.me references
        # --------------------------------------------------------


        if sources.entity_urls:
            url_rows = connection.execute(
                """
                SELECT
                    m.chat_id,
                    u.url
                FROM tg_entity_urls u
                INNER JOIN tg_messages m
                    ON m.id = u.message_id
                INNER JOIN tg_graph_roots r
                    ON r.chat_id = m.chat_id
                WHERE lower(TRY_CAST(u.url AS VARCHAR))
                    LIKE '%t.me/%'
                   OR lower(TRY_CAST(u.url AS VARCHAR))
                    LIKE '%telegram.me/%'
                """
            ).fetchall()


            usernames: dict[str, dict[str, Any]] = defaultdict(
                lambda: {
                    "count": 0,
                    "roots": set(),
                }
            )


            for root_id, url in url_rows:
                match = _TME_RE.search(str(url or ""))
                if not match:
                    continue


                username = match.group(1).lower()
                usernames[username]["count"] += 1
                usernames[username]["roots"].add(int(root_id))


            if usernames:
                connection.execute(
                    """
                    CREATE OR REPLACE TEMP TABLE tg_graph_usernames (
                        username VARCHAR PRIMARY KEY
                    )
                    """
                )


                connection.executemany(
                    "INSERT INTO tg_graph_usernames VALUES (?)",
                    [(name,) for name in usernames],
                )


                mapped = connection.execute(
                    """
                    SELECT
                        c.id,
                        lower(c.name) AS username
                    FROM tg_chats c
                    INNER JOIN tg_graph_usernames q
                        ON lower(c.name) = q.username
                    """
                ).fetchall()


                for target_id, username in mapped:
                    target = int(target_id)
                    if target in roots:
                        continue


                    stats = usernames[str(username)]
                    item = evidence[target]


                    item["tme_count"] += int(stats["count"])
                    item["root_connections"].update(stats["roots"])


        # --------------------------------------------------------
        # 4. audience overlap
        # --------------------------------------------------------


        if sources.chats_users:
            audience_rows = connection.execute(
                """
                WITH root_users AS (
                    SELECT DISTINCT
                        cu.user_id,
                        r.chat_id AS root_id
                    FROM tg_chats_users cu
                    INNER JOIN tg_graph_roots r
                        ON r.chat_id = cu.chat_id
                ),
                overlap_calc AS (
                    SELECT
                        other.chat_id AS target_id,
                        COUNT(DISTINCT other.user_id)::BIGINT AS overlap,
                        COUNT(DISTINCT ru.root_id)::BIGINT AS connected_roots
                    FROM root_users ru
                    INNER JOIN tg_chats_users other
                        ON other.user_id = ru.user_id
                    WHERE other.chat_id NOT IN (
                        SELECT chat_id FROM tg_graph_roots
                    )
                    GROUP BY other.chat_id
                )
                SELECT
                    target_id,
                    overlap,
                    connected_roots
                FROM overlap_calc
                WHERE overlap >= ?
                ORDER BY overlap DESC
                """,
                [min_audience_overlap],
            ).fetchall()


            for target_id, overlap, connected_roots in audience_rows:
                target = int(target_id)
                item = evidence[target]
                item["audience_overlap"] = int(overlap or 0)
                item["audience_root_count"] = int(connected_roots or 0)


        if not evidence:
            payload = {
                "generated_at": _now(),
                "roots": roots,
                "candidate_count": 0,
                "candidates": [],
            }


            output.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            return payload


        ids = sorted(evidence)


        connection.execute(
            """
            CREATE OR REPLACE TEMP TABLE tg_graph_targets (
                chat_id BIGINT PRIMARY KEY
            )
            """
        )


        connection.executemany(
            "INSERT INTO tg_graph_targets VALUES (?)",
            [(value,) for value in ids],
        )


        metadata_rows = connection.execute(
            """
            SELECT
                c.id,
                TRY_CAST(c.telegram_id AS VARCHAR),
                COALESCE(TRY_CAST(c.name AS VARCHAR), ''),
                COALESCE(TRY_CAST(c.title AS VARCHAR), ''),
                COALESCE(TRY_CAST(c.description AS VARCHAR), ''),
                COALESCE(TRY_CAST(c.members_count AS BIGINT), 0),
                COALESCE(TRY_CAST(c.is_scam AS BOOLEAN), FALSE),
                COALESCE(TRY_CAST(c.is_fake AS BOOLEAN), FALSE),
                COALESCE(TRY_CAST(c.is_restricted AS BOOLEAN), FALSE),
                COALESCE(TRY_CAST(c.type AS VARCHAR), '')
            FROM tg_chats c
            INNER JOIN tg_graph_targets q
                ON q.chat_id = c.id
            """
        ).fetchall()


        results: list[dict[str, Any]] = []


        for (
            chat_id,
            telegram_id,
            username,
            title,
            description,
            members_count,
            scam,
            fake,
            restricted,
            chat_type,
        ) in metadata_rows:
            chat_id = int(chat_id)
            item = evidence[chat_id]


            linked = int(item.get("linked", 0))
            forwards = int(item.get("forward_count", 0))
            tme = int(item.get("tme_count", 0))
            overlap = int(item.get("audience_overlap", 0))

            forward_root_count = int(
                item.get("forward_root_count", 0) or 0
            )
            audience_root_count = int(
                item.get("audience_root_count", 0) or 0
            )

            connected_root_count = max(
                len(item.get("root_connections", set())),
                forward_root_count,
                audience_root_count,
            )

            if connected_root_count < 1:
                continue


            score = 0.0


            if linked:
                score += 45.0


            if forwards:
                score += min(
                    30.0,
                    7.0 + 6.0 * math.log1p(forwards),
                )


            if tme:
                score += min(
                    30.0,
                    8.0 + 5.0 * math.log1p(tme),
                )


            if overlap:
                score += min(
                    25.0,
                    4.0 * math.sqrt(overlap),
                )


            if scam or fake:
                score -= 50.0


            if restricted:
                score -= 10.0


            score = round(max(0.0, min(100.0, score)), 1)


            reasons: list[str] = []
            if linked:
                reasons.append("linked_chat")
            if forwards:
                reasons.append("forward_source")
            if tme:
                reasons.append("telegram_reference")
            if overlap:
                reasons.append("audience_overlap")


            results.append(
                {
                    "teragram_chat_id": str(chat_id),
                    "telegram_id": telegram_id or "",
                    "username": str(username or "").lstrip("@"),
                    "title": title or "",
                    "description": description or "",
                    "type": chat_type or "",
                    "members_count": int(members_count or 0),
                    "historical_discovery_score": score,
                    "reasons": reasons,
                    "evidence": {
                        "linked_edges": linked,
                        "forward_count": forwards,
                        "telegram_reference_count": tme,
                        "audience_overlap": overlap,
                        "connected_root_count": connected_root_count,
                    },
                    "flags": {
                        "scam": bool(scam),
                        "fake": bool(fake),
                        "restricted": bool(restricted),
                    },
                    "requires_live_validation": True,
                }
            )


        results.sort(
            key=lambda row: (
                row["historical_discovery_score"],
                row["members_count"],
            ),
            reverse=True,
        )


        results = results[:max_results]


        payload = {
            "generated_at": _now(),
            "source": "teragram_graph_discovery",
            "root_candidate_count": len(roots),
            "candidate_count": len(results),
            "min_audience_overlap": min_audience_overlap,
            "max_results": max_results,
            "note": (
                "Historical graph candidates only. "
                "Live MTProto validation is required before use."
            ),
            "candidates": results,
        }


        output.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


        return payload


    finally:
        connection.close()
